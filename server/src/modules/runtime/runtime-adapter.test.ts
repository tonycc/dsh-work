import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { buildAcpChildEnvironment } from './acp-json-rpc-client.ts'
import { DshAcpRuntimeAdapter, renderSystemPrompt } from './dsh-acp-runtime-adapter.ts'
import { createManagedDshAcpProcessConfiguration } from './dsh-acp-process-configuration.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from './dsh-runtime-installation.ts'
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
    invalid.input.file_mounts = [fileMount('/tmp/input.txt', '库存：120')]
    assert.throws(() => compileRuntimeManifest(invalid), /\/workspace\/input/)
  })

  it('rejects input content whose digest differs from the immutable manifest', () => {
    const invalid = manifest('run-checksum', 'attempt-1')
    invalid.input.file_mounts = [{ ...fileMount('/workspace/input/inventory.csv.txt', '库存：120'), content_sha256: '0'.repeat(64) }]
    assert.throws(() => compileRuntimeManifest(invalid), /checksum mismatch/)
  })

  it('renders only the permission-filtered, versioned knowledge context into the DSH prompt', () => {
    const input = manifest('run-knowledge', 'attempt-1')
    input.knowledge_context = [{
      documentId: 'knowledge-policy-v1',
      title: '库存管理规范',
      version: '1.0',
      effectiveDate: '2026-08-01',
      dataScope: 'domain:supply-chain',
      contentChecksum: 'a'.repeat(32),
      excerpt: '可用库存低于安全库存时应进入预警。',
    }]
    const rendered = renderSystemPrompt(compileRuntimeManifest(input).manifest)
    assert.match(rendered, /【1】库存管理规范 v1\.0/)
    assert.match(rendered, /只能依据以下已授权知识片段/)
    assert.match(rendered, /可用库存低于安全库存/)
  })

  it('renders exact read-only attachment paths so the Agent does not guess filenames', () => {
    const input = manifest('run-attachment-context', 'attempt-1')
    input.input.file_mounts = [fileMount('/workspace/input/01-inventory-uat.txt', '物料,库存\nA-01,120')]

    const rendered = renderSystemPrompt(compileRuntimeManifest(input).manifest)
    assert.match(rendered, /# 当前 Run 输入文件/)
    assert.match(rendered, /inventory\.csv/)
    assert.match(rendered, /读取路径：input\/01-inventory-uat\.txt/)
    assert.match(rendered, /不得猜测文件名/)
  })
})

describe('DSH ACP Runtime Adapter', () => {
  it('passes only an explicit non-secret environment baseline to DSH workers', () => {
    const originalDatabaseUrl = process.env.DSH_WORK_DATABASE_URL
    process.env.DSH_WORK_DATABASE_URL = 'postgres://user:password@database/internal'
    try {
      const environment = buildAcpChildEnvironment({ DSH_AGENT_SYSTEM_PROMPT: '安全提示词' })
      assert.equal(environment['DSH_WORK_DATABASE_URL'], undefined)
      assert.equal(environment['DSH_AGENT_SYSTEM_PROMPT'], '安全提示词')
      assert.throws(
        () => buildAcpChildEnvironment({ DEEPSEEK_API_KEY: 'not-forwarded' }),
        /禁止直接注入敏感变量/,
      )
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DSH_WORK_DATABASE_URL
      else process.env.DSH_WORK_DATABASE_URL = originalDatabaseUrl
    }
  })

  it('mounts DSH managed credentials without copying a secret into process config', () => {
    const configuration = createManagedDshAcpProcessConfiguration({
      runtimeHome: '/opt/dsh-runtime',
      projectRoot: '/opt/dsh-work',
    })

    assert.equal(configuration.cwd, '/opt/dsh-runtime')
    assert.equal(configuration.env?.['DEEPSEEK_API_KEY'], undefined)
    assert.equal(configuration.env?.['DSH_ACP_BASE_CONFIG'], '/opt/dsh-runtime/examples/acp-agent/cordis.yml')
    assert.ok(configuration.args.includes('/opt/dsh-work/server/config/dsh/acp-managed-credentials.cordis.yml'))
  })

  it('accepts a managed command without requiring a sibling source checkout', () => {
    const configuration = createManagedDshAcpProcessConfiguration({
      runtimeHome: '/opt/dsh-runtime',
      projectRoot: '/opt/dsh-work',
      command: '/opt/dsh-runtime/bin/dsh-acp',
      args: ['--config', '/opt/dsh-work/server/config/dsh/acp-managed-credentials.cordis.yml'],
    })
    assert.equal(configuration.command, '/opt/dsh-runtime/bin/dsh-acp')
    assert.equal(configuration.cwd, '/opt/dsh-runtime')
  })

  it('verifies a managed DSH distribution against the runtime lock', async () => {
    const fixture = await createManagedDistributionFixture()
    const dataRoot = join(fixture.projectRoot, 'persistent-data')
    const sessionsRoot = join(dataRoot, 'managed-dsh-sessions')
    const installation = await resolveDshRuntimeInstallation({
      projectRoot: fixture.projectRoot,
      env: {
        DSH_RUNTIME_HOME: fixture.runtimeHome,
        DSH_RUNTIME_COMMAND: process.execPath,
        DSH_RUNTIME_ARGS_JSON: '["--version"]',
        DSH_WORK_DATA_ROOT: dataRoot,
        DSH_WORK_DSH_SESSIONS_ROOT: sessionsRoot,
      },
    })

    assert.equal(installation.version, '0.1.1-rc.2')
    assert.equal(installation.commit, fixture.commit)
    assert.equal(installation.launchMode, 'managed-distribution')
    assert.deepEqual(installation.process.args.slice(0, 1), ['--version'])
    assert.equal(installation.process.env?.['DSH_WORK_DSH_SESSIONS_ROOT'], sessionsRoot)
    await stat(join(dataRoot, 'dsh-config/acp-managed-credentials.cordis.yml'))
  })

  it('fails closed when the managed DSH version differs from the runtime lock', async () => {
    const fixture = await createManagedDistributionFixture('0.1.1-rc.3')
    await assert.rejects(resolveDshRuntimeInstallation({
      projectRoot: fixture.projectRoot,
      env: {
        DSH_RUNTIME_HOME: fixture.runtimeHome,
        DSH_RUNTIME_COMMAND: process.execPath,
      },
    }), /version mismatch/)
  })

  it('does not allow environment expectations to bypass the runtime lock', async () => {
    const fixture = await createManagedDistributionFixture('0.1.1-rc.3')
    await assert.rejects(resolveDshRuntimeInstallation({
      projectRoot: fixture.projectRoot,
      env: {
        DSH_RUNTIME_HOME: fixture.runtimeHome,
        DSH_RUNTIME_COMMAND: process.execPath,
        DSH_EXPECTED_VERSION: '0.1.1-rc.3',
        DSH_EXPECTED_COMMIT: fixture.commit,
      },
    }), /DSH_EXPECTED_VERSION must match runtime lock/)
  })

  it('negotiates ACP before the Runtime starts serving traffic', async () => {
    await preflightDshRuntime({
      home: process.cwd(),
      version: 'test',
      commit: '0'.repeat(40),
      protocolVersion: 1,
      launchMode: 'managed-distribution',
      process: {
        command: process.execPath,
        args: ['--experimental-strip-types', mockWorker],
        cwd: process.cwd(),
      },
    })
  })

  it('reports scheduling state without rejecting an Attempt already admitted by Postgres', async () => {
    const adapter = await createAdapter()
    await adapter.configureScheduling('draining')
    assert.equal((await adapter.health()).acceptingRuns, false)
    const admitted = await adapter.execute(manifest('run-admitted-before-draining', 'attempt-1'))
    assert.equal((await admitted.done).status, 'completed')

    await adapter.configureScheduling('accepting')
    assert.equal((await adapter.health()).acceptingRuns, true)
    const handle = await adapter.execute(manifest('run-accepting', 'attempt-1'))
    assert.equal((await handle.done).status, 'completed')

    await adapter.configureScheduling('disabled')
    assert.equal((await adapter.health()).acceptingRuns, false)
  })

  it('creates an isolated Attempt and emits ordered safe completion events', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-complete', 'attempt-1')
    input.input.file_mounts = [fileMount('/workspace/input/inventory.csv.txt', '物料,库存\nA-01,120')]
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
    const mountedPath = join(result.attemptDirectory, 'workspace/input/inventory.csv.txt')
    assert.equal(await readFile(mountedPath, 'utf8'), '物料,库存\nA-01,120')
    assert.equal((await stat(mountedPath)).mode & 0o777, 0o400)
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
    assert.equal(resolved?.safe_metadata['tool_name'], 'tool-inventory-read')
  })

  it('auto-confirms an allowed tool when the manifest requires no approval', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-no-approval', 'attempt-1', '[permission] read inventory')
    input.permission_policy.approval_mode = 'never'
    const handle = await adapter.execute(input)
    const events: RuntimeEvent[] = []
    adapter.subscribe(input.run_id, event => { events.push(event) })

    const result = await handle.done
    assert.equal(result.status, 'completed')
    const resolved = events.find(event => event.event_type === 'approval.resolved')
    assert.equal(resolved?.safe_metadata['decision'], 'allow_once')
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

  it('does not attribute an unsolicited ACP cancellation to the user', async () => {
    const adapter = await createAdapter()
    const input = manifest('run-unexpected-cancel', 'attempt-1', '[unexpected-cancel] stop without request')
    const handle = await adapter.execute(input)
    const events: RuntimeEvent[] = []
    adapter.subscribe(input.run_id, event => { events.push(event) })

    const result = await handle.done
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'RUNTIME_CANCELLED_UNEXPECTEDLY')
    assert.ok(events.some(event => event.event_type === 'run.failed'))
    assert.ok(!events.some(event => event.event_type === 'run.cancelled'))
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

  it('classifies Worker crashes without leaving the execution active', async () => {
    const adapter = await createAdapter()
    const handle = await adapter.execute(manifest('run-crash', 'attempt-1', '[crash] terminate worker'))
    const result = await handle.done
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'RUNTIME_WORKER_CRASH')
    assert.equal((await adapter.health()).activeExecutions, 0)
  })

  it('preserves model, Tool timeout and network fault categories from ACP', async () => {
    const scenarios = [
      ['model-failure', 'MODEL_INVOCATION_FAILED'],
      ['tool-timeout', 'TOOL_TIMEOUT'],
      ['network-failure', 'NETWORK_UNAVAILABLE'],
    ] as const
    for (const [trigger, expectedCode] of scenarios) {
      const adapter = await createAdapter()
      const handle = await adapter.execute(manifest(`run-${trigger}`, 'attempt-1', `[${trigger}] inject fault`))
      const result = await handle.done
      assert.equal(result.status, 'failed')
      assert.equal(result.errorCode, expectedCode)
    }
  })

  it('marks an active execution as a retryable service shutdown failure', async () => {
    const adapter = await createAdapter(100)
    const handle = await adapter.execute(manifest('run-shutdown', 'attempt-1', '[hang] service shutdown'))
    await waitForStatus(adapter, 'run-shutdown', 'running')
    await adapter.close()
    const result = await handle.done
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'SERVICE_SHUTDOWN')
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

function fileMount(mountPath: string, content: string) {
  return {
    file_id: 'file-inventory',
    mount_path: mountPath,
    access: 'read_only' as const,
    source_name: 'inventory.csv',
    media_type: 'text/csv',
    content_sha256: createHash('sha256').update(content).digest('hex'),
    content,
  }
}

async function createManagedDistributionFixture(version = '0.1.1-rc.2') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-work-runtime-installation-test-'))
  const projectRoot = join(root, 'dsh-work')
  const runtimeHome = join(root, 'runtime')
  const configDirectory = join(projectRoot, 'server/config/dsh')
  const commit = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
  await mkdir(configDirectory, { recursive: true })
  await mkdir(runtimeHome, { recursive: true })
  await mkdir(join(runtimeHome, 'config'), { recursive: true })
  await writeFile(join(configDirectory, 'runtime-lock.json'), JSON.stringify({
    version: '0.1.1-rc.2', commit, protocolVersion: 1,
  }))
  await writeFile(
    join(configDirectory, 'acp-managed-credentials.cordis.yml'),
    '- id: base\n  name: cordis:include\n  config:\n    path: ../../runtime/config/cordis.yml\n    patches:\n      - insert:\n          - id: policy\n            name: __DSH_WORK_TOOL_POLICY_MODULE__\n',
  )
  await writeFile(join(configDirectory, 'dsh-work-tool-policy.js'), 'export function apply() {}\n')
  await writeFile(join(runtimeHome, 'dsh-runtime.json'), JSON.stringify({
    name: 'deepseek-harness', version, commit, protocolVersion: 1, acpConfig: 'config/cordis.yml',
  }))
  await writeFile(join(runtimeHome, 'config/cordis.yml'), '[]\n')
  return { projectRoot, runtimeHome, commit }
}

function manifest(runId: string, attemptId: string, message = 'summarize inventory'): RuntimeManifest {
  return {
    manifest_version: '1.0',
    run_id: runId,
    attempt_id: attemptId,
    session_id: `session-${runId}`,
    workspace_id: 'ws-supply-analysis',
    agent_version_id: 'agent-supply-v1',
    agent_configuration: {
      system_prompt: '你是供应链分析助手，只能在当前用户授权的数据范围内提供准确回答。',
      skill_instructions: [{
        id: 'skill-inventory',
        version: '1.0.0',
        instructions: '读取当前授权范围内的库存信息，说明数据口径，并明确列出缺料风险和建议动作。',
      }],
    },
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
    knowledge_context: [],
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
