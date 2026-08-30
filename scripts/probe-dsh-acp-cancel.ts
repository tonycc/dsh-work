import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AcpJsonRpcClient } from '../server/src/modules/runtime/acp-json-rpc-client.ts'
import { createManagedDshAcpProcessConfiguration } from '../server/src/modules/runtime/dsh-acp-process-configuration.ts'

const dshRepository = resolve(process.env['DSH_REPOSITORY'] ?? resolve(process.cwd(), '../deepseek-harness'))
const projectRoot = resolve(import.meta.dirname, '..')
const dshPackage = JSON.parse(await readFile(join(dshRepository, 'package.json'), 'utf8')) as { version?: string }
const probeRoot = await mkdtemp(join(tmpdir(), 'dsh-work-dsh-cancel-probe-'))
const workspace = join(probeRoot, 'workspace')
await mkdir(workspace, { recursive: true })

const diagnostics: string[] = []
const client = AcpJsonRpcClient.launch(
  createManagedDshAcpProcessConfiguration({
    dshRepository,
    projectRoot,
    env: {
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_SNAPSHOT_SESSIONS_ROOT: join(probeRoot, 'sessions'),
    },
    shutdownGraceMs: 5000,
  }),
  {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onDiagnostic: message => { diagnostics.push(message) },
  },
)

try {
  const initialize = await client.initialize()
  const sessionId = await client.newSession(workspace)
  const startedAt = performance.now()
  const prompt = client.prompt(
    sessionId,
    '请生成一份非常详细的企业数据治理实施手册，至少包含一百个章节。在完成前不要提前总结。',
  )
  await delay(250)
  await client.cancel(sessionId)
  const response = await Promise.race([
    prompt,
    delay(30_000, undefined, { ref: false })
      .then(() => { throw new Error('Real cancellation did not settle within 30 seconds') }),
  ])
  if (response['stopReason'] !== 'cancelled') {
    throw new Error(`Real cancellation returned unexpected stopReason: ${String(response['stopReason'])}`)
  }
  console.log(JSON.stringify({
    ok: true,
    dshVersion: dshPackage.version ?? 'unknown',
    protocolVersion: initialize['protocolVersion'],
    transport: 'acp-stdio',
    realModelCancellationVerified: true,
    stopReason: 'cancelled',
    settleMs: Math.round(performance.now() - startedAt),
    diagnosticCount: diagnostics.length,
  }))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({
    ok: false,
    realModelCancellationVerified: false,
    error: message.slice(0, 1000),
    diagnostic: diagnostics.at(-1)?.slice(0, 2000) ?? null,
  }))
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
}
