import type { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import type { RunRepository } from '../../modules/run/run-repository.ts'
import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import type { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'
const tenantId = 'tenant-dsh-work'

export function registerConversationRoutes(
  router: Router,
  conversations: PostgresConversationRepository,
  orchestration: RunOrchestrationService,
  runs: RunRepository,
  agents: PostgresAgentService,
  authorization?: PostgresAuthorizationService,
  operations?: PostgresOperationsService,
  skills?: PostgresSkillService,
  agentMembers?: PostgresWorkspaceAgentMemberService,
) {
  router.get(`${basePath}/tasks`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    return envelope('workbench', await conversations.listTasks(userId), 'postgres')
  })

  router.post(`${basePath}/sessions`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const authorizationContext = sessionAuthorizationContext(identity)
    const body = await readJsonBody<{
      title: string
      workspaceId?: string
      agentId?: string
      skillId?: string
      workspaceAgentMemberId?: string
    }>(request)
    const access = await authorization?.authorizeWorkbench({ userId, ...authorizationContext })
    // Team workspaces must start sessions through the agent member
    // association (pinned version); personal workspaces, non-members and
    // omitted workspaceIds keep the existing resolution path untouched
    // (AC-23).
    const workspaceType = await authorization?.resolveWorkspaceType(body.workspaceId, userId)
    const agentVersionId = workspaceType === 'team'
      ? await resolveTeamSessionAgentVersion(agentMembers, agents, body, userId, access?.roleIds ?? identity.roleIds)
      : await agents.resolveWorkbenchAgentVersion(
          body.agentId,
          userId,
          access?.roleIds ?? identity.roleIds,
        )
    const selectedSkillVersion = body.skillId && skills
      ? await skills.resolveWorkbenchSkillVersion(body.skillId)
      : undefined
    const session = await orchestration.createSession({
      userId,
      title: body.title,
      workspaceId: body.workspaceId,
      agentVersionId,
      selectedSkillVersionId: selectedSkillVersion?.id,
      authorizationContext,
    })
    return httpResult(201, envelope('workbench', session, 'postgres'))
  })

  if (skills) {
    router.get(`${basePath}/skills`, async (_request, context) => {
      const identity = requireRequestIdentity(context, 'workbench')
      await authorization?.authorizeWorkbench({
        userId: identity.userId,
        ...sessionAuthorizationContext(identity),
      })
      return envelope('workbench', await skills.listWorkbenchSkills(), 'postgres')
    })
  }

  router.delete(`${basePath}/sessions/:sessionId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
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
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return task
      ? envelope('workbench', task, 'postgres')
      : httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
  })

  router.post(`${basePath}/sessions/:sessionId/runs`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
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
      authorizationContext: sessionAuthorizationContext(identity),
    })
    if (!run) throw new Error('Run 创建失败')
    const task = await conversations.getTask(run.id, userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/cancel`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await orchestration.cancel(
      context.params['runId'] ?? '',
      userId,
      sessionAuthorizationContext(identity),
    )
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.post(`${basePath}/runs/:runId/retry`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await orchestration.retry(
      context.params['runId'] ?? '',
      userId,
      sessionAuthorizationContext(identity),
    )
    const task = await conversations.getTask(context.params['runId'] ?? '', userId)
    return httpResult(202, envelope('workbench', task, 'postgres'))
  })

  router.get(`${basePath}/runs/:runId/events`, async (request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const runId = context.params['runId'] ?? ''
    const task = await conversations.getTask(runId, userId)
    if (!task) return httpResult(404, { error: { code: 'run_not_found', message: 'Run 不存在或不可访问' } })
    await streamRunEvents(response, request.headers['last-event-id'], runId, runs)
  })
}

/**
 * Team session start must go through the agent member association (TW-02
 * 单一会话绑定): the member's pinned version is used instead of the
 * platform's current active version. A team request without the association
 * — or one whose raw agentId resolves to a version different from the
 * member's pinned version — is rejected so the session can never silently
 * switch agent versions.
 */
async function resolveTeamSessionAgentVersion(
  agentMembers: PostgresWorkspaceAgentMemberService | undefined,
  agents: PostgresAgentService,
  body: { workspaceId?: string; agentId?: string; workspaceAgentMemberId?: string },
  userId: string,
  roleIds: string[],
) {
  if (!agentMembers || !body.workspaceId || !body.workspaceAgentMemberId) {
    throw new Error('团队空间对话必须通过 Agent 成员关联发起')
  }
  const member = await agentMembers.requireAvailableAgentMemberVersion(
    body.workspaceId,
    body.workspaceAgentMemberId,
  )
  if (body.agentId !== undefined) {
    const rawVersionId = await agents.resolveWorkbenchAgentVersion(body.agentId, userId, roleIds)
    if (rawVersionId !== member.agentVersionId) {
      throw new Error('团队空间对话必须通过 Agent 成员关联发起')
    }
  }
  return member.agentVersionId
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
