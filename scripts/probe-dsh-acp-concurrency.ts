import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AcpJsonRpcClient } from '../server/src/modules/runtime/acp-json-rpc-client.ts'
import { createManagedDshAcpProcessConfiguration } from '../server/src/modules/runtime/dsh-acp-process-configuration.ts'

const execFileAsync = promisify(execFile)
const dshRepository = resolve(process.env['DSH_REPOSITORY'] ?? resolve(process.cwd(), '../deepseek-harness'))
const projectRoot = resolve(import.meta.dirname, '..')
const dshPackage = JSON.parse(await readFile(join(dshRepository, 'package.json'), 'utf8')) as { version?: string }

const results = []
for (const concurrency of [1, 3, 5]) results.push(await runBatch(concurrency))
console.log(JSON.stringify({
  ok: true,
  dshVersion: dshPackage.version ?? 'unknown',
  transport: 'acp-stdio',
  modelConfiguration: 'dsh-default',
  batches: results,
}))

async function runBatch(concurrency: number): Promise<Record<string, number>> {
  const batchRoot = await mkdtemp(join(tmpdir(), `dsh-work-dsh-concurrency-${concurrency}-`))
  const texts = Array.from({ length: concurrency }, () => '')
  const diagnostics: string[] = []
  const clients = Array.from({ length: concurrency }, (_value, index) => AcpJsonRpcClient.launch(
    createManagedDshAcpProcessConfiguration({
      dshRepository,
      projectRoot,
      env: {
        DSH_PERMISSION_MODE: 'workspace-write',
        DSH_SNAPSHOT_SESSIONS_ROOT: join(batchRoot, `sessions-${index}`),
      },
      shutdownGraceMs: 5000,
    }),
    {
      onSessionUpdate: ({ update }) => {
        const content = update['content']
        if (update['sessionUpdate'] !== 'agent_message_chunk' || !isRecord(content)) return
        if (content['type'] === 'text' && typeof content['text'] === 'string') texts[index] += content['text']
      },
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onDiagnostic: message => { diagnostics.push(message) },
    },
  ))

  let sampling = true
  let peakRssKiB = 0
  try {
    const workspaces = await Promise.all(Array.from({ length: concurrency }, async (_value, index) => {
      const workspace = join(batchRoot, `workspace-${index}`)
      await mkdir(workspace, { recursive: true })
      return workspace
    }))
    await Promise.all(clients.map(client => client.initialize()))
    const sessions = await Promise.all(clients.map((client, index) => client.newSession(workspaces[index]!)))
    const roots = clients.map(client => client.pid).filter((pid): pid is number => pid !== undefined)
    const sampler = samplePeakRss(roots, () => sampling, peak => { peakRssKiB = Math.max(peakRssKiB, peak) })
    const startedAt = performance.now()
    const responses = await Promise.all(clients.map((client, index) => client.prompt(
      sessions[index]!,
      `这是 dsh-work 并发基线 ${concurrency}-${index + 1}。请只回复 OK，不要调用工具。`,
    )))
    const elapsedMs = Math.round(performance.now() - startedAt)
    sampling = false
    await sampler
    if (responses.some(response => response['stopReason'] !== 'end_turn')) {
      throw new Error(`Concurrency ${concurrency} returned a non-end_turn response`)
    }
    if (texts.some(text => text.trim().length === 0)) {
      throw new Error(`Concurrency ${concurrency} received an empty assistant response`)
    }
    return {
      concurrency,
      succeeded: responses.length,
      elapsedMs,
      peakWorkerTreeRssMiB: Math.round(peakRssKiB / 1024),
      diagnosticCount: diagnostics.length,
    }
  } finally {
    sampling = false
    await Promise.all(clients.map(client => client.close().catch(() => undefined)))
  }
}

async function samplePeakRss(
  roots: number[],
  active: () => boolean,
  observe: (rssKiB: number) => void,
): Promise<void> {
  while (active()) {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='])
    const processes = stdout.trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number))
    const descendants = new Set(roots)
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, parent] of processes) {
        if (pid === undefined || parent === undefined || descendants.has(pid) || !descendants.has(parent)) continue
        descendants.add(pid)
        changed = true
      }
    }
    observe(processes.reduce((total, [pid, , rss]) => (
      pid !== undefined && rss !== undefined && descendants.has(pid) ? total + rss : total
    ), 0))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
