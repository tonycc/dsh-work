import { randomUUID } from 'node:crypto'

import type { ChatMessage, RunStep, TaskRun } from '../../../domain/types.ts'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import type { RunState } from '../../run/run-types.ts'

const tenantId = 'tenant-dsh-work'

interface SessionRow {
  id: string
  workspaceId: string | null
  agentVersionId: string
  title: string
  createdAt: Date
}

interface TaskRow {
  id: string
  sessionId: string
  status: RunState
  currentAttemptId: string | null
  createdAt: Date
  updatedAt: Date
  title: string
  workspaceId: string | null
  workspaceName: string | null
  agentVersion: string
  owner: string
}

interface MessageRow {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  runId: string | null
}

interface EventRow {
  id: string
  eventType: string
  displayMessage: string | null
  occurredAt: Date
}

interface ArtifactRow {
  id: string
  name: string
  artifactType: 'xlsx' | 'docx' | 'pdf' | 'markdown'
  version: number
  sizeBytes: string | number
  createdAt: Date
  workspaceId: string | null
}

export class PostgresConversationRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createSession(input: {
    userId: string
    title: string
    workspaceId?: string | null
    agentVersionId?: string
  }) {
    const id = `session-${randomUUID()}`
    const agentVersionId = input.agentVersionId ?? 'agent-version-dsh-work-assistant-1'
    const workspaceId = input.workspaceId && input.workspaceId !== 'standalone' ? input.workspaceId : null
    const [row] = await this.database<SessionRow[]>`
      insert into sessions (
        id, tenant_id, workspace_id, created_by, agent_version_id, title, status
      ) values (
        ${id}, ${tenantId}, ${workspaceId}, ${input.userId}, ${agentVersionId},
        ${truncateTitle(input.title)}, 'active'
      )
      returning id, workspace_id as "workspaceId", agent_version_id as "agentVersionId",
                title, created_at as "createdAt"
    `
    if (!row) throw new Error('Session 创建失败')
    return { ...row, createdAt: row.createdAt.toISOString() }
  }

  async requireSession(sessionId: string, userId: string) {
    const [row] = await this.database<SessionRow[]>`
      select id, workspace_id as "workspaceId", agent_version_id as "agentVersionId",
             title, created_at as "createdAt"
        from sessions
       where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${userId}
         and status = 'active'
    `
    if (!row) throw new Error(`Session 不存在或不可访问：${sessionId}`)
    return { ...row, createdAt: row.createdAt.toISOString() }
  }

  async appendMessage(input: {
    sessionId: string
    runId: string
    role: 'user' | 'assistant'
    content: string
    messageId?: string
  }) {
    const id = input.messageId ?? `message-${randomUUID()}`
    await this.database`
      insert into messages (id, tenant_id, session_id, run_id, role, content)
      values (${id}, ${tenantId}, ${input.sessionId}, ${input.runId}, ${input.role}, ${input.content})
      on conflict (id) do nothing
    `
    await this.database`
      update sessions set last_active_at = now()
       where tenant_id = ${tenantId} and id = ${input.sessionId}
    `
    return id
  }

  async getRunPrompt(runId: string) {
    const [row] = await this.database<{ content: string }[]>`
      select content from messages
       where tenant_id = ${tenantId} and run_id = ${runId} and role = 'user'
       order by created_at asc limit 1
    `
    if (!row) throw new Error(`Run 没有关联的用户消息：${runId}`)
    return row.content
  }

  async listTasks(userId: string): Promise<TaskRun[]> {
    const rows = await this.database<TaskRow[]>`
      select r.id, r.session_id as "sessionId", r.status,
             r.current_attempt_id as "currentAttemptId", r.created_at as "createdAt",
             r.updated_at as "updatedAt", s.title, s.workspace_id as "workspaceId",
             w.name as "workspaceName", av.version as "agentVersion", u.display_name as owner
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
       where r.tenant_id = ${tenantId} and r.requested_by = ${userId}
       order by r.created_at desc
       limit 50
    `
    return Promise.all(rows.map((row) => this.mapTask(row)))
  }

  async getTask(runId: string, userId: string): Promise<TaskRun | null> {
    const [row] = await this.database<TaskRow[]>`
      select r.id, r.session_id as "sessionId", r.status,
             r.current_attempt_id as "currentAttemptId", r.created_at as "createdAt",
             r.updated_at as "updatedAt", s.title, s.workspace_id as "workspaceId",
             w.name as "workspaceName", av.version as "agentVersion", u.display_name as owner
        from runs r
        join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id
        join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
       where r.tenant_id = ${tenantId} and r.id = ${runId} and r.requested_by = ${userId}
    `
    return row ? this.mapTask(row) : null
  }

  private async mapTask(row: TaskRow): Promise<TaskRun> {
    const messages = await this.database<MessageRow[]>`
      select id, role, content, created_at as "createdAt", run_id as "runId"
        from messages
       where tenant_id = ${tenantId} and session_id = ${row.sessionId}
         and role in ('user', 'assistant')
       order by created_at asc
    `
    const events = row.currentAttemptId
      ? await this.database<EventRow[]>`
          select id, event_type as "eventType", display_message as "displayMessage",
                 occurred_at as "occurredAt"
            from run_events
           where tenant_id = ${tenantId} and attempt_id = ${row.currentAttemptId}
           order by sequence asc
        `
      : []
    const runMessages = messages.filter((message) => message.runId === row.id)
    const artifacts = await this.database<ArtifactRow[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt", a.workspace_id as "workspaceId"
        from artifact_versions av
        join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
       where av.tenant_id = ${tenantId} and av.source_run_id = ${row.id}
       order by av.version_no desc
    `
    const prompt = runMessages.find((message) => message.role === 'user')?.content ?? row.title
    return {
      id: row.id,
      title: row.title,
      prompt,
      status: mapStatus(row.status),
      workspaceId: row.workspaceId ?? 'standalone',
      workspaceName: row.workspaceName ?? '未加入工作空间',
      sessionId: row.sessionId,
      agentVersion: `dsh-work-assistant@${row.agentVersion}`,
      createdAt: formatDateTime(row.createdAt),
      updatedAt: formatDateTime(row.updatedAt),
      owner: row.owner,
      messages: messages.map(mapMessage),
      steps: mapSteps(row.id, events, row.status),
      sources: [],
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.artifactType,
        version: artifact.version,
        size: formatSize(Number(artifact.sizeBytes)),
        createdAt: formatDateTime(artifact.createdAt),
        runId: row.id,
        workspaceId: artifact.workspaceId ?? 'standalone',
        summary: '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
      })),
      attachments: [],
      summary: row.status === 'succeeded' ? '本轮对话已由 DSH Runtime 执行完成。' : undefined,
      error: row.status === 'failed'
        ? { code: 'RUNTIME_EXECUTION_FAILED', message: '本轮执行失败', suggestion: '可点击重试创建新的 Attempt。' }
        : undefined,
    }
  }
}

function mapMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
  }
}

function mapSteps(runId: string, events: EventRow[], status: RunState): RunStep[] {
  if (events.length === 0) {
    return [{ id: `${runId}-queued`, title: '等待 DSH Runtime 调度', detail: '任务已写入 PostgreSQL 队列。', status: 'pending' }]
  }
  return events
    .filter((event) => !['assistant.delta', 'assistant.completed'].includes(event.eventType))
    .map((event, index, visibleEvents) => ({
      id: event.id,
      title: eventTitle(event.eventType),
      detail: event.displayMessage ?? '执行状态已更新。',
      status: eventStepStatus(event.eventType, status, index === visibleEvents.length - 1),
    }))
}

function eventTitle(eventType: string) {
  const titles: Record<string, string> = {
    'run.queued': '进入 Runtime 队列',
    'run.started': 'DSH Worker 开始执行',
    'approval.required': '等待权限确认',
    'approval.resolved': '权限确认完成',
    'run.cancel_requested': '正在取消',
    'run.cancelled': '执行已取消',
    'run.failed': '执行失败',
    'run.completed': '执行完成',
  }
  return titles[eventType] ?? '运行事件'
}

function eventStepStatus(eventType: string, status: RunState, isLast: boolean): RunStep['status'] {
  if (eventType === 'approval.required') return 'awaiting_approval'
  if (eventType === 'run.failed' || eventType === 'run.cancelled') return 'failed'
  if (eventType === 'run.completed') return 'succeeded'
  if (isLast && ['queued', 'running', 'cancel_requested'].includes(status)) return 'running'
  return 'succeeded'
}

function mapStatus(status: RunState): TaskRun['status'] {
  if (status === 'cancel_requested') return 'running'
  return status
}

function truncateTitle(value: string) {
  const title = value.trim()
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
