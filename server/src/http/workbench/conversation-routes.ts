import type { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { RunRepository } from '../../modules/run/run-repository.ts'
import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { envelope, httpResult, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'
const tenantId = 'tenant-dsh-work'
const userId = 'U00001'

export function registerConversationRoutes(
  router: Router,
  conversations: PostgresConversationRepository,
  orchestration: RunOrchestrationService,
  runs: RunRepository,
  agents: PostgresAgentService,
  authorization?: PostgresAuthorizationService,
  operations?: PostgresOperationsService,
) {
  router.get(`${basePath}/tasks`, async () => {
    await authorization?.authorizeWorkbench({ userId })
    return envelope('workbench', await conversations.listTasks(userId), 'postgres')
  })

  router.post(`${basePath}/sessions`, async (request) => {
    const body = await readJsonBody<{ title: string; workspaceId?: string; agentId?: string }>(request)
    const agentVersionId = await agents.resolveWorkbenchAgentVersion(body.agentId, userId)
    const session = await orchestration.createSession({
      userId,
      title: body.title,
      workspaceId: body.workspaceId,
      agentVersionId,
    })
    return httpResult(201, envelope('workbench', session, 'postgres'))
  })

  router.delete(`${basePath}/sessions/:sessionId`, async (_request, context) => {
    await authorization?.authorizeWorkbench({ userId })
    const sessionId = context.params['sessionId'] ?? ''
    const archived = await conversations.archiveSession(sessionId, userId)
    await operations?.appendAudit(
      userId,
      'session.delete',
      sessionId,
      'success',
      `trace-session-${crypto.randomUUID()}`,
      '员工删除对话',
      'session',
    ).catch((error: unknown) => console.error('session deletion audit failed', error))
    return envelope('workbench', archived, 'postgres')
  })

  router.get(`${basePath}/runs/:runId`, async (_request, context) => {
    await authorization?.authorizeWorkbench({ userId })
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return task
      ? envelope('workbench', task, 'postgres')
      : httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
  })

  router.post(`${basePath}/sessions/:sessionId/runs`, async (request, context) => {
    const body = await readJsonBody<{ prompt: string; idempotencyKey?: string; fileIds?: string[] }>(request)
    if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.some(id => typeof id !== 'string'))) {
      throw new Error('fileIds 必须是文件标识数组')
    }
    if ((body.fileIds?.length ?? 0) > 5) throw new Error('每次 Run 最多分析 5 个文件')
    const headerKey = request.headers['idempotency-key']
    const run = await orchestration.startRun({
      userId,
      sessionId: context.params['sessionId'] ?? '',
      prompt: body.prompt,
      idempotencyKey: body.idempotencyKey ?? (Array.isArray(headerKey) ? headerKey[0] : headerKey) ?? crypto.randomUUID(),
      fileIds: body.fileIds ?? [],
    })
    if (!run) throw new Error('Run 创建失败')
    const task = await conversations.getTask(run.id, userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/cancel`, async (_request, context) => {
    await orchestration.cancel(context.params['runId'] ?? '', userId)
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/retry`, async (_request, context) => {
    await orchestration.retry(context.params['runId'] ?? '', userId)
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.get(`${basePath}/runs/:runId/events`, async (request, context, response) => {
    await authorization?.authorizeWorkbench({ userId })
    const runId = context.params['runId'] ?? ''
    const task = await conversations.getTask(runId, userId)
    if (!task) return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    await streamRunEvents(response, request.headers['last-event-id'], runId, runs)
  })
}

export async function streamRunEvents(
  response: RunEventStreamResponse,
  lastEventHeader: string | string[] | undefined,
  runId: string,
  runs: Pick<RunRepository, 'readEventsAfterEvent' | 'getRun'>,
  pollIntervalMs = 250,
  heartbeatIntervalMs = 15_000,
) {
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
  let cursor = Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader
  let closed = false
  response.on('close', () => { closed = true })
  let emptyTerminalPolls = 0
  let heartbeatAt = Date.now()

  while (!closed) {
    const events = await runs.readEventsAfterEvent(tenantId, runId, cursor)
    for (const event of events) {
      cursor = event.id
      response.write(`id: ${event.id}\n`)
      response.write(`event: ${event.eventType}\n`)
      response.write(`data: ${JSON.stringify({
        event_id: event.id,
        run_id: event.runId,
        attempt_id: event.attemptId,
        sequence: event.sequence,
        event_type: event.eventType,
        occurred_at: event.occurredAt,
        display_message: event.displayMessage,
        safe_metadata: event.safeMetadata,
        trace_id: event.traceId,
      })}\n\n`)
    }
    const run = await runs.getRun(tenantId, runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status) && events.length === 0) {
      emptyTerminalPolls += 1
      if (emptyTerminalPolls >= 2) break
    } else {
      emptyTerminalPolls = 0
    }
    if (Date.now() - heartbeatAt >= heartbeatIntervalMs) {
      response.write(`: heartbeat ${Date.now()}\n\n`)
      heartbeatAt = Date.now()
    }
    await wait(pollIntervalMs)
  }
  if (!closed) response.end()
}

interface RunEventStreamResponse {
  writeHead(statusCode: number, headers: Record<string, string>): unknown
  flushHeaders(): void
  write(chunk: string): boolean
  end(): unknown
  on(event: 'close', listener: () => void): unknown
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}
