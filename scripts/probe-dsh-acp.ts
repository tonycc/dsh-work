import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AcpJsonRpcClient } from '../server/src/modules/runtime/acp-json-rpc-client.ts'
import { resolveDshRuntimeInstallation } from '../server/src/modules/runtime/dsh-runtime-installation.ts'

const dshRepository = resolve(
  process.env['DSH_RUNTIME_HOME'] ?? process.env['DSH_REPOSITORY'] ?? resolve(process.cwd(), '../deepseek-harness'),
)
const projectRoot = resolve(import.meta.dirname, '..')
const dshPackage = JSON.parse(await readFile(join(dshRepository, 'package.json'), 'utf8')) as { version?: string }
const probeRoot = await mkdtemp(join(tmpdir(), 'dsh-work-dsh-acp-probe-'))
const workspace = join(probeRoot, 'workspace')
await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }))

const diagnostics: string[] = []
const processConfiguration = (await resolveDshRuntimeInstallation({
  projectRoot,
  env: { ...process.env, DSH_RUNTIME_HOME: dshRepository },
})).process
const client = AcpJsonRpcClient.launch(
  {
    ...processConfiguration,
    env: {
      ...processConfiguration.env,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: join(probeRoot, 'sessions'),
    },
    shutdownGraceMs: 5000,
  },
  {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onDiagnostic: message => { diagnostics.push(message) },
  },
)

try {
  const initialize = await client.initialize()
  const sessionId = await client.newSession(workspace)
  await client.cancel(sessionId)
  console.log(JSON.stringify({
    ok: true,
    dshVersion: dshPackage.version ?? 'unknown',
    protocolVersion: initialize['protocolVersion'],
    sessionCreated: sessionId.length > 0,
    transport: 'acp-stdio',
    realModelPromptExecuted: false,
    diagnosticCount: diagnostics.length,
  }))
} finally {
  await client.close()
}
