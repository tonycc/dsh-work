import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AcpJsonRpcClient } from '../server/src/modules/runtime/acp-json-rpc-client.ts'
import { createManagedDshAcpProcessConfiguration } from '../server/src/modules/runtime/dsh-acp-process-configuration.ts'

const dshRepository = resolve(process.env['DSH_REPOSITORY'] ?? resolve(process.cwd(), '../deepseek-harness'))
const projectRoot = resolve(import.meta.dirname, '..')
const dshPackage = JSON.parse(await readFile(join(dshRepository, 'package.json'), 'utf8')) as { version?: string }
const probeRoot = await mkdtemp(join(tmpdir(), 'dsh-work-dsh-real-model-probe-'))
const workspace = join(probeRoot, 'workspace')
const sessionsRoot = join(probeRoot, 'sessions')
await mkdir(workspace, { recursive: true })
const artifactProbe = process.argv.includes('--artifact')
const toolProbe = process.argv.includes('--tool') || artifactProbe
const toolMarker = 'DSH_WORK_TOOL_7F3C91A2'
const artifactMarker = 'DSH_WORK_ARTIFACT_4B8E20D7'
if (toolProbe) {
  const inputDirectory = join(workspace, 'input')
  await mkdir(inputDirectory, { recursive: true })
  const inputPath = join(inputDirectory, artifactProbe ? 'source.txt' : 'inventory-status.txt')
  await writeFile(inputPath, `${artifactProbe ? artifactMarker : toolMarker}\n`, { flag: 'wx' })
  await chmod(inputPath, 0o444)
  await chmod(inputDirectory, 0o555)
}
if (artifactProbe) {
  await mkdir(join(workspace, 'output'), { recursive: true })
}

let assistantText = ''
const diagnostics: string[] = []
const client = AcpJsonRpcClient.launch(
  createManagedDshAcpProcessConfiguration({
    dshRepository,
    projectRoot,
    env: {
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
    },
    shutdownGraceMs: 5000,
  }),
  {
    onSessionUpdate: ({ update }) => {
      const content = update['content']
      if (update['sessionUpdate'] !== 'agent_message_chunk' || !isRecord(content)) return
      if (content['type'] === 'text' && typeof content['text'] === 'string') assistantText += content['text']
    },
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onDiagnostic: message => { diagnostics.push(message) },
  },
)

let sessionId: string | undefined
let timedOut = false
try {
  const initialize = await client.initialize()
  sessionId = await client.newSession(workspace)
  const prompt = artifactProbe
    ? '请读取只读文件 input/source.txt，将其中的完整标记写入 output/report.md，文件内容只包含一级标题“POC 成果”和该标记。完成后只回复“成果已生成”。'
    : toolProbe
      ? '请使用文件读取工具读取 input/inventory-status.txt，并且只回复文件中的完整标记。不要猜测文件内容。'
      : '这是一条 dsh-work 合成链路测试消息。请只回复 DSH_WORK_MODEL_OK，不要调用任何工具。'
  const response = await Promise.race([
    client.prompt(sessionId, prompt),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        timedOut = true
        reject(new Error('Real model probe timed out after 180 seconds'))
      }, 180_000).unref()
    }),
  ])
  const stopReason = response['stopReason']
  if (assistantText.trim().length === 0) throw new Error('Real model probe received no committed assistant text')
  if (toolProbe && !artifactProbe && !assistantText.includes(toolMarker)) {
    throw new Error('Real Tool probe response did not contain the workspace-only marker')
  }
  const evidence = await waitForSessionEvidence(sessionsRoot, toolProbe)
  const artifact = artifactProbe ? await verifyArtifact(workspace, artifactMarker) : undefined
  console.log(JSON.stringify({
    ok: true,
    dshVersion: dshPackage.version ?? 'unknown',
    protocolVersion: initialize['protocolVersion'],
    transport: 'acp-stdio',
    modelConfiguration: 'dsh-default',
    probeMode: artifactProbe ? 'artifact' : toolProbe ? 'read-only-tool' : 'model',
    realModelPromptExecuted: true,
    realReadOnlyToolVerified: toolProbe,
    tokenUsageRecorded: true,
    inputTokens: evidence.inputTokens,
    outputTokens: evidence.outputTokens,
    toolCallCount: evidence.toolCallCount,
    toolResultCount: evidence.toolResultCount,
    artifactVerified: artifact !== undefined,
    artifactBytes: artifact?.bytes ?? 0,
    artifactSha256: artifact?.sha256 ?? null,
    assistantTextReceived: true,
    assistantResponseBytes: Buffer.byteLength(assistantText),
    stopReason: typeof stopReason === 'string' ? stopReason : 'unknown',
    diagnosticCount: diagnostics.length,
  }))
} catch (error) {
  if (timedOut && sessionId !== undefined) await client.cancel(sessionId).catch(() => undefined)
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({
    ok: false,
    realModelPromptExecuted: true,
    error: message.slice(0, 1000),
    diagnostic: diagnostics.at(-1)?.slice(0, 2000) ?? null,
  }))
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface SessionEvidence {
  inputTokens: number
  outputTokens: number
  toolCallCount: number
  toolResultCount: number
}

async function waitForSessionEvidence(root: string, requireTool: boolean): Promise<SessionEvidence> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const evidence = await readSessionEvidence(root)
    if (evidence !== undefined && (!requireTool || evidence.toolCallCount > 0 && evidence.toolResultCount > 0)) {
      return evidence
    }
    await delay(100)
  }
  throw new Error('DSH canonical Session Log did not contain the expected usage and Tool evidence')
}

async function readSessionEvidence(root: string): Promise<SessionEvidence | undefined> {
  const paths = await findSessionLogs(root)
  let inputTokens = 0
  let outputTokens = 0
  let usageFound = false
  let toolCallCount = 0
  let toolResultCount = 0
  for (const path of paths) {
    const content = await readFile(path, 'utf8')
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      const event = JSON.parse(line) as unknown
      if (!isRecord(event) || typeof event['type'] !== 'string') continue
      if (event['type'] === 'tool/call') toolCallCount += 1
      if (event['type'] === 'tool/result') toolResultCount += 1
      if (event['type'] !== 'assistant/message' || !isRecord(event['data'])) continue
      const usage = event['data']['usage']
      if (!isRecord(usage)) continue
      if (typeof usage['inputTokens'] !== 'number' || typeof usage['outputTokens'] !== 'number') continue
      usageFound = true
      inputTokens += usage['inputTokens']
      outputTokens += usage['outputTokens']
    }
  }
  return usageFound ? { inputTokens, outputTokens, toolCallCount, toolResultCount } : undefined
}

async function findSessionLogs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const paths: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSessionLogs(path))
    else if (entry.isFile() && entry.name === 'session.jsonl') paths.push(path)
  }
  return paths
}

async function verifyArtifact(
  workspace: string,
  marker: string,
): Promise<{ bytes: number; sha256: string }> {
  const input = await readFile(join(workspace, 'input/source.txt'), 'utf8')
  if (input !== `${marker}\n`) throw new Error('Artifact probe modified the read-only input')
  const artifact = await readFile(join(workspace, 'output/report.md'))
  if (!artifact.toString('utf8').includes(marker)) throw new Error('Artifact output does not contain the source marker')
  return {
    bytes: artifact.byteLength,
    sha256: createHash('sha256').update(artifact).digest('hex'),
  }
}
