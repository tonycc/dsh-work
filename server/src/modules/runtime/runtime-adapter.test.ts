import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { DshAcpRuntimeAdapter } from './dsh-acp-runtime-adapter.ts'
import { compileRuntimeManifest } from './manifest-compiler.ts'
import type { RuntimeEvent, RuntimeManifest } from './runtime-types.ts'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const mockWorker = join(moduleDirectory, 'testing/mock-acp-worker.ts')
const adapters: DshAcpRuntimeAdapter[] = []

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()))
})

describe('Runtime Manifest compiler', () => {
  it('produces a stable digest independent of object key insertion order', () => {
    const original = manifest('run-stable', 'attempt-1')
    const first = compileRuntimeManifest(original)
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as unknown as RuntimeManifest
    const second = compileRuntimeManifest(reordered)
    assert.equal(first.canonicalJson, second.canonicalJson)
    assert.equal(first.sha256, second.sha256)
  })

  it('rejects writable or out-of-root input mounts', () => {
    const invalid = manifest('run-invalid', 'attempt-1')
    invalid.input.file_mounts = [{ file_id: 'file-1', mount_path: '/tmp/input.txt', access: 'read_only' }]
    assert.throws(() => compileRuntimeManifest(invalid), /\/workspace\/input/)
  })
})

describe('DSH ACP Runtime Adapter', () => {
  it('creates an isolated Attempt and emits ordered safe completion events', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-complete', 'attempt-1')
    const handle = await adapter.execute(input)
    const events: RuntimeEvent[] = []
    adapter.subscribe(input.run_id, event => { events.push(event) })

    const result = await handle.done
    assert.equal(result.status, 'completed')
    assert.deepEqual(events.map(event => event.event_type), [
      'run.queued',
      'run.started',
      'assistant.delta',
      'assistant.completed',
      'run.completed',
    ])
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4, 5])
    assert.match(events[2]?.display_message ?? '', /Mock response/)

    const stored = JSON.parse(await readFile(join(result.attemptDirectory, 'manifest.json'), 'utf8')) as RuntimeManifest
    assert.equal(stored.run_id, input.run_id)
    assert.equal(result.manifestSha256, compileRuntimeManifest(input).sha256)
  })

  it('routes permission requests through a fail-closed decision and audit events', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-permission', 'attempt-1', '[permission] read inventory')
    const handle = await adapter.execute(input)
    const events: RuntimeEvent[] = []
    adapter.subscribe(input.run_id, event => { events.push(event) })

    const result = await handle.done
    assert.equal(result.status, 'completed')
    assert.ok(events.some(event => event.event_type === 'approval.required'))
    const resolved = events.find(event => event.event_type === 'approval.resolved')
    assert.equal(resolved?.safe_metadata['decision'], 'reject_once')
  })

  it('cancels an active ACP prompt and reaches a single terminal state', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-cancel', 'attempt-1', '[hang] wait for cancellation')
    const handle = await adapter.execute(input)
    await waitForStatus(adapter, input.run_id, 'running')

    assert.deepEqual(await adapter.cancel(input.run_id, 'usr-linlan'), { accepted: true })
    const result = await handle.done
    assert.equal(result.status, 'cancelled')
    assert.equal(result.errorCode, null)
  })

  it('turns a deadline into RUN_TIMEOUT and keeps attempts isolated', async () => {
    const adapter = await createAdapter(100)
    const first = manifest('run-timeout', 'attempt-1', '[hang] exceed deadline')
    first.limits.timeout_seconds = 1
    const second = manifest('run-other', 'attempt-1', 'finish independently')
    const firstHandle = await adapter.execute(first)
    const secondHandle = await adapter.execute(second)

    const [timedOut, completed] = await Promise.all([firstHandle.done, secondHandle.done])
    assert.equal(timedOut.status, 'failed')
    assert.equal(timedOut.errorCode, 'RUN_TIMEOUT')
    assert.equal(completed.status, 'completed')
    assert.notEqual(timedOut.attemptDirectory, completed.attemptDirectory)
  })
})

async function createAdapter(shutdownGraceMs = 500): Promise<DshAcpRuntimeAdapter> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'dsh-work-runtime-test-'))
  const adapter = new DshAcpRuntimeAdapter({
    runtimeId: 'runtime-test',
    runtimeRoot,
    dshRepository: process.cwd(),
    process: {
      command: process.execPath,
      args: ['--experimental-strip-types', mockWorker],
      cwd: process.cwd(),
    },
    shutdownGraceMs,
  })
  adapters.push(adapter)
  return adapter
}

function manifest(runId: string, attemptId: string, message = 'summarize inventory'): RuntimeManifest {
  return {
    manifest_version: '1.0',
    run_id: runId,
    attempt_id: attemptId,
    session_id: `session-${runId}`,
    workspace_id: 'ws-supply-analysis',
    agent_version_id: 'agent-supply-v1',
    user_context: {
      user_id: 'usr-linlan',
      tenant_id: 'tenant-demo',
      role_ids: ['role-employee'],
    },
    permission_policy: {
      approval_mode: 'risk_based',
      network_policy: 'deny',
      write_policy: 'workspace_only',
    },
    skills: [{ id: 'skill-inventory', version: '1.0.0' }],
    tools: [{ id: 'tool-inventory-read', version: '1.0.0' }],
    data_scopes: ['region:east', 'domain:supply-chain'],
    model_route_id: null,
    input: { message, file_mounts: [] },
    limits: { timeout_seconds: 5, max_output_bytes: 64 * 1024, max_tool_calls: 10 },
    created_at: '2026-08-29T10:00:00.000Z',
    trace_id: `trace-${runId}`,
  }
}

async function waitForStatus(
  adapter: DshAcpRuntimeAdapter,
  runId: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (adapter.status(runId)?.status === status) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${runId} to reach ${status}`)
}
