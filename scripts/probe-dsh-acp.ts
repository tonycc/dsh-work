import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AcpJsonRpcClient } from '../server/src/modules/runtime/acp-json-rpc-client.ts'

const dshRepository = resolve(process.env['DSH_REPOSITORY'] ?? resolve(process.cwd(), '../deepseek-harness'))
const dshPackage = JSON.parse(await readFile(join(dshRepository, 'package.json'), 'utf8')) as { version?: string }
const probeRoot = await mkdtemp(join(tmpdir(), 'dsh-work-dsh-acp-probe-'))
const workspace = join(probeRoot, 'workspace')
await import('node:fs/promises').then(({ mkdir }) => mkdir(workspace, { recursive: true }))

const diagnostics: string[] = []
const client = AcpJsonRpcClient.launch(
  {
    command: 'pnpm',
    args: ['run', 'demo:acp'],
    cwd: dshRepository,
    env: {
      DEEPSEEK_API_KEY: process.env['DEEPSEEK_API_KEY'] ?? 'sk-dsh-work-keyless-probe',
      DSH_PERMISSION_MODE: 'workspace-write',
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
