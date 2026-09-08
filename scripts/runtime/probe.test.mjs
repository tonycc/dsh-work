import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readSessionEvidence, runProbe, verifyArtifact, withDeadline, withProbeWorkspace } from './probe.ts'

// Local stdio peer exercises real ACP transport without model credentials or network.
const fakeRuntime = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
let workspace, pending
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  appendFileSync(process.env.PROBE_TEST_TRACE, JSON.stringify({ method: request.method, pid: process.pid, workspace: request.params?.cwd, tools: process.env.DSH_ALLOWED_TOOLS_JSON }) + '\\n')
  if (request.method === 'initialize') reply(request.id, { protocolVersion: 1 })
  if (request.method === 'session/new') { workspace = request.params.cwd; reply(request.id, { sessionId: 'fake-session' }) }
  if (request.method === 'session/cancel' && pending) reply(pending, { stopReason: 'cancelled' })
  if (request.method !== 'session/prompt') return
  const prompt = request.params.prompt[0].text
  if (prompt.includes('一百个章节')) { pending = request.id; return }
  let text = 'DSH_WORK_MODEL_OK'
  const logs = [{ type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 3 } } }]
  if (prompt.includes('input/')) {
    const artifact = prompt.includes('source.txt')
    text = readFileSync(join(workspace, 'input', artifact ? 'source.txt' : 'inventory-status.txt'), 'utf8').trim()
    logs.push({ type: 'tool/call' }, { type: 'tool/result' })
    if (artifact) writeFileSync(join(workspace, 'output/report.md'), '# POC 成果\\n' + text)
  }
  mkdirSync(process.env.DSH_SNAPSHOT_SESSIONS_ROOT, { recursive: true })
  writeFileSync(join(process.env.DSH_SNAPSHOT_SESSIONS_ROOT, 'session.jsonl'), logs.map(event => JSON.stringify(event)).join('\\n') + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\\n')
  reply(request.id, { stopReason: process.env.PROBE_TEST_BAD_STOP ? 'cancelled' : 'end_turn' })
})
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-probe-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'fake.mjs')
  const trace = join(root, 'trace.jsonl')
  await writeFile(script, fakeRuntime)
  return { root, trace, configuration: { command: process.execPath, args: [script], cwd: root, env: { PROBE_TEST_TRACE: trace } } }
}

async function assertCleaned(trace) {
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  for (const event of events) {
    if (event.workspace) assert.equal(existsSync(event.workspace), false, 'temporary workspace leaked')
  }
  for (const pid of new Set(events.map(event => event.pid))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'ACP worker survived probe exit')
  }
  return events
}

for (const mode of ['handshake', 'model', 'tool', 'artifact', 'cancel', 'concurrency']) {
  test(`${mode} probe executes with a local ACP peer and cleans up`, async t => {
    const { trace, configuration } = await fixture(t)
    const result = await runProbe(mode, configuration, 'test')
    assert.equal(result.ok, true)
    const events = await assertCleaned(trace)
    const prompts = events.filter(event => event.method === 'session/prompt')
    assert.equal(prompts.length, mode === 'handshake' ? 0 : mode === 'concurrency' ? 9 : 1)
    if (mode === 'artifact') { assert.equal(result.artifactVerified, true); assert.match(result.artifactSha256, /^[a-f0-9]{64}$/) }
    if (mode === 'tool') { assert.equal(result.realReadOnlyToolVerified, true); assert.equal(result.toolResultCount, 1) }
    if (mode === 'cancel') assert.equal(result.stopReason, 'cancelled')
    if (mode === 'concurrency') assert.deepEqual(result.batches.map(batch => batch.succeeded), [1, 3, 5])
    if (prompts.length) assert.equal(prompts[0].tools, JSON.stringify(mode === 'artifact' ? ['read', 'write'] : mode === 'tool' ? ['read'] : []))
  })
}

test('non-end_turn model responses fail and still close the worker', async t => {
  const { trace, configuration } = await fixture(t)
  configuration.env.PROBE_TEST_BAD_STOP = '1'
  await assert.rejects(runProbe('model', configuration, 'test'), /requires end_turn/)
  await assertCleaned(trace)
})

test('partial startup failures close registered workers and remove read-only input', async () => {
  let root, closed = 0
  await assert.rejects(withProbeWorkspace(async (directory, clients) => {
    root = directory
    clients.push({ close: async () => { closed += 1 } })
    await mkdir(join(root, 'workspace-0/input'), { recursive: true })
    await writeFile(join(root, 'workspace-0/input/source.txt'), 'source')
    await chmod(join(root, 'workspace-0/input'), 0o555)
    throw new Error('second worker failed to start')
  }), /second worker failed/)
  assert.equal(closed, 1)
  assert.equal(existsSync(root), false)
})

test('deadlines reject stalled operations', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 10), /timed out/)
  assert.equal(await withDeadline(Promise.resolve('done'), 1000), 'done')
})

test('Session Log tolerates an in-progress trailing record but rejects corrupt completed records', async t => {
  const { root } = await fixture(t)
  const log = join(root, 'session.jsonl')
  await writeFile(log, '{"type":"tool/call"}\n{"type":')
  assert.equal(await readSessionEvidence(root), undefined, 'Tool events alone are not usage evidence')
  await writeFile(log, '{broken}\n')
  await assert.rejects(readSessionEvidence(root), SyntaxError)
})

test('artifact verification rejects input mutation and missing output marker', async t => {
  const { root } = await fixture(t)
  await mkdir(join(root, 'input'))
  await mkdir(join(root, 'output'))
  await writeFile(join(root, 'input/source.txt'), 'tampered\n')
  await assert.rejects(verifyArtifact(root, 'expected'), /modified the read-only input/)
  await writeFile(join(root, 'input/source.txt'), 'expected\n')
  await writeFile(join(root, 'output/report.md'), 'missing marker')
  await assert.rejects(verifyArtifact(root, 'expected'), /does not contain/)
})

test('help and invalid modes never attempt to resolve a runtime', () => {
  const cli = join(import.meta.dirname, 'probe.ts')
  for (const [args, status] of [[[], 0], [['--help'], 0], [['typo'], 2], [['model', 'artifact'], 2]]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
      cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, DSH_RUNTIME_HOME: '/nonexistent-dsh-runtime' },
    })
    assert.equal(result.status, status, result.stderr)
    assert.match(result.stdout + result.stderr, /Usage: pnpm probe/)
    assert.doesNotMatch(result.stdout + result.stderr, /ENOENT/)
  }
})
