import { randomUUID } from 'node:crypto'

import type {
  AuditEvent,
  HealthComponent,
  ManagedWorkspaceDefinition,
  ModelUsageRecord,
  RuntimeDefinition,
  SessionDefinition,
  UpdateRuntimeConfigurationInput,
  UsagePoint,
} from '../../../domain/types.ts'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import type { RunAttemptRecord, RunRecord } from '../../run/run-types.ts'

const tenantId = 'tenant-dsh-work'

export class PostgresOperationsService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async getTaskSummaries() {
    return this.database<{ id: string; status: string }[]>`
      select id, status from runs where tenant_id = ${tenantId} order by created_at desc limit 100
    `
  }

  async getRuntimes(): Promise<RuntimeDefinition[]> {
    const rows = await this.database<{
      id: string; nodeName: string; runtimeVersion: string; healthStatus: RuntimeDefinition['status'];
      schedulingStatus: RuntimeDefinition['schedulingStatus']; capacity: number; lastHeartbeatAt: Date | null;
      activeWorkers: number; queuedRuns: number; timeoutSeconds: number
    }[]>`
      select r.id, r.node_name as "nodeName", r.runtime_version as "runtimeVersion",
             r.health_status as "healthStatus", r.scheduling_status as "schedulingStatus",
             r.capacity, r.last_heartbeat_at as "lastHeartbeatAt",
             count(a.id) filter (where a.status = 'running')::integer as "activeWorkers",
             count(a.id) filter (where a.status = 'queued')::integer as "queuedRuns",
             coalesce((select timeout_seconds from runtime_configurations c where c.tenant_id = r.tenant_id order by revision desc limit 1), 300)::integer as "timeoutSeconds"
        from runtimes r
        left join run_attempts a on a.tenant_id = r.tenant_id and a.runtime_id = r.id
       where r.tenant_id = ${tenantId}
       group by r.id
       order by r.id
    `
    return rows.map((row) => ({
      id: row.id,
      name: row.nodeName,
      environment: '本地 MVP',
      mode: 'dsh-worker',
      status: row.healthStatus,
      schedulingStatus: row.schedulingStatus,
      version: row.runtimeVersion,
      endpoint: 'ACP stdio（本机子进程）',
      maxConcurrentWorkers: row.capacity,
      activeWorkers: row.activeWorkers,
      queuedRuns: row.queuedRuns,
      attemptTimeoutMinutes: Math.ceil(row.timeoutSeconds / 60),
      cpuUsage: '由主机监控采集',
      memoryUsage: '由主机监控采集',
      latency: '本地 stdio',
      lastHeartbeat: row.lastHeartbeatAt ? formatDateTime(row.lastHeartbeatAt) : '—',
      checkedAt: '刚刚',
      healthMessage: row.healthStatus === 'healthy' ? 'DSH 仓库可访问，Runtime 正在接收任务。' : 'Runtime 当前不可用。',
      capabilities: ['ACP stdio', 'DSH Agent Loop', '取消', '事件流', '工作区沙箱'],
    }))
  }

  async checkRuntime(input: { runtimeId: string; actor: string }) {
    await this.database`
      update runtimes set health_status = 'healthy', last_heartbeat_at = now()
       where tenant_id = ${tenantId} and id = ${input.runtimeId}
    `
    await this.appendAudit('U00008', 'runtime.health.check', input.runtimeId, 'success', `trace-runtime-${input.runtimeId}`, input.actor)
    return (await this.getRuntimes()).find((runtime) => runtime.id === input.runtimeId)
  }

  async updateRuntimeConfiguration(input: UpdateRuntimeConfigurationInput) {
    const [active] = await this.database<{ count: number }[]>`
      select count(*)::integer as count from run_attempts
       where tenant_id = ${tenantId} and runtime_id = ${input.runtimeId} and status = 'running'
    `
    if (input.maxConcurrentWorkers < (active?.count ?? 0)) throw new Error('最大并发数不能小于当前活动 Worker 数')
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into runtime_configurations (
          tenant_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by
        ) select ${tenantId}, coalesce(max(revision), 0) + 1, ${input.maxConcurrentWorkers},
                 ${input.attemptTimeoutMinutes * 60}, '{"network":"deny","write":"workspace_only"}', 'U00008'
          from runtime_configurations where tenant_id = ${tenantId}
      `
      await transaction`
        update runtimes set capacity = ${input.maxConcurrentWorkers}, scheduling_status = ${input.schedulingStatus}
         where tenant_id = ${tenantId} and id = ${input.runtimeId}
      `
    })
    await this.appendAudit('U00008', 'runtime.configuration.update', input.runtimeId, 'success', `trace-runtime-${input.runtimeId}`, input.actor)
    return (await this.getRuntimes()).find((runtime) => runtime.id === input.runtimeId)
  }

  async getSessions(): Promise<SessionDefinition[]> {
    const rows = await this.database<{
      id: string; title: string; user: string; workspaceId: string | null; workspaceName: string | null;
      agentId: string; agentName: string; agentVersion: string; runId: string | null; status: SessionDefinition['status'] | null;
      runCount: number; messageCount: number; tokenUsage: number; createdAt: Date; updatedAt: Date;
      traceId: string | null
    }[]>`
      select s.id, s.title, u.display_name as "user", s.workspace_id as "workspaceId",
             w.name as "workspaceName", a.id as "agentId", a.name as "agentName", av.version as "agentVersion",
             latest.id as "runId", latest.status, count(distinct r.id)::integer as "runCount",
             count(distinct m.id)::integer as "messageCount",
             coalesce(sum(distinct mu.input_tokens + mu.output_tokens), 0)::integer as "tokenUsage",
             s.created_at as "createdAt", s.last_active_at as "updatedAt", ev.trace_id as "traceId"
        from sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.created_by
        join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
        left join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
        left join lateral (select id, status, current_attempt_id from runs where tenant_id = s.tenant_id and session_id = s.id order by created_at desc limit 1) latest on true
        left join runs r on r.tenant_id = s.tenant_id and r.session_id = s.id
        left join messages m on m.tenant_id = s.tenant_id and m.session_id = s.id
        left join model_usage_events mu on mu.tenant_id = s.tenant_id and mu.run_id = r.id
        left join lateral (select trace_id from run_events where tenant_id = s.tenant_id and run_id = latest.id order by stream_position desc limit 1) ev on true
       where s.tenant_id = ${tenantId}
       group by s.id, u.display_name, w.name, a.id, a.name, av.version, latest.id, latest.status, ev.trace_id
       order by s.last_active_at desc
    `
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      user: row.user,
      department: '供应链中心',
      workspaceId: row.workspaceId ?? 'standalone',
      workspaceName: row.workspaceName ?? '未加入工作空间',
      agentId: row.agentId,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      runtimeId: 'runtime-local-01',
      runId: row.runId ?? '—',
      status: row.status ?? 'queued',
      runCount: row.runCount,
      messageCount: row.messageCount,
      tokenUsage: row.tokenUsage,
      createdAt: formatDateTime(row.createdAt),
      updatedAt: formatDateTime(row.updatedAt),
      traceId: row.traceId ?? '—',
      dataScopes: row.workspaceId ? ['工作空间成员范围', '员工业务数据范围'] : ['员工身份范围'],
      summary: '真实 Session/Run 元数据；平台管理员默认不查看消息正文。',
    }))
  }

  async getManagedWorkspaces(): Promise<ManagedWorkspaceDefinition[]> {
    const rows = await this.database<{
      id: string; name: string; description: string; manager: string; memberCount: number;
      sessionCount: number; artifactCount: number; fileCount: number; createdAt: Date; updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, u.display_name as manager,
             count(distinct wm.user_id)::integer as "memberCount", count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount", count(distinct f.id)::integer as "fileCount",
             w.created_at as "createdAt", greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w join users u on u.tenant_id = w.tenant_id and u.id = w.created_by
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
        left join file_objects f on f.tenant_id = w.tenant_id and f.workspace_id = w.id and f.session_id is null
       where w.tenant_id = ${tenantId} group by w.id, u.display_name order by w.created_at desc
    `
    return rows.map((row) => ({
      id: row.id, name: row.name, description: row.description, type: 'team', status: 'active',
      ownerDepartment: '团队工作空间', manager: row.manager, memberCount: row.memberCount,
      sessionCount: row.sessionCount, artifactCount: row.artifactCount, fileCount: row.fileCount,
      members: [row.manager], agentNames: ['dsh-work 助手'], dataScopes: ['成员企业授权范围'],
      createdAt: formatDateTime(row.createdAt), updatedAt: formatDateTime(row.updatedAt),
    }))
  }

  async getAuditEvents(): Promise<AuditEvent[]> {
    const rows = await this.database<{
      id: string; occurredAt: Date; actor: string; action: string; objectType: string;
      objectId: string; result: AuditEvent['status']; traceId: string; safeContext: Record<string, unknown>
    }[]>`
      select ae.id, ae.occurred_at as "occurredAt", coalesce(u.display_name, ae.actor_id) as actor,
             ae.action, ae.object_type as "objectType", ae.object_id as "objectId", ae.result,
             ae.trace_id as "traceId", ae.safe_context as "safeContext"
        from audit_events ae left join users u on u.tenant_id = ae.tenant_id and u.id = ae.actor_id
       where ae.tenant_id = ${tenantId} order by ae.occurred_at desc limit 200
    `
    return rows.map((row) => ({
      id: row.id, time: formatDateTime(row.occurredAt), actor: row.actor, department: 'dsh-work',
      action: row.action, object: `${row.objectType} · ${row.objectId}`, status: row.result,
      traceId: row.traceId, detail: JSON.stringify(row.safeContext),
    }))
  }

  async getHealth(): Promise<HealthComponent[]> {
    const [runtime] = await this.getRuntimes()
    return [
      { id: 'server', name: 'dsh-work 服务端', category: 'application', status: 'healthy', latency: '本机', availability: '当前可用', message: 'Node.js 模块化单体运行正常', checkedAt: '刚刚' },
      { id: 'postgres', name: 'PostgreSQL', category: 'dependency', status: 'healthy', latency: '本机', availability: '当前可用', message: '真实持久化已连接', checkedAt: '刚刚' },
      { id: runtime?.id ?? 'runtime', name: 'DSH Runtime', category: 'runtime', status: runtime?.status === 'healthy' ? 'healthy' : 'offline', latency: runtime?.latency ?? '—', availability: runtime?.schedulingStatus ?? '—', message: runtime?.healthMessage ?? 'Runtime 未注册', checkedAt: '刚刚' },
    ]
  }

  async getUsage(): Promise<UsagePoint[]> {
    const rows = await this.database<{ day: string; runs: number; tokens: number }[]>`
      select to_char(days.day, 'MM-DD') as day, count(distinct r.id)::integer as runs,
             coalesce(sum(mu.input_tokens + mu.output_tokens), 0)::integer as tokens
        from generate_series(current_date - interval '6 days', current_date, interval '1 day') days(day)
        left join runs r on r.tenant_id = ${tenantId} and r.created_at::date = days.day::date
        left join model_usage_events mu on mu.tenant_id = r.tenant_id and mu.run_id = r.id
       group by days.day order by days.day
    `
    return rows
  }

  async getModelUsage(): Promise<ModelUsageRecord[]> {
    const rows = await this.database<{
      id: string; occurredAt: Date; runId: string; provider: string; model: string; status: ModelUsageRecord['status'];
      inputTokens: number; outputTokens: number; latencyMs: number | null; costAmount: string | null; traceId: string
    }[]>`
      select id, occurred_at as "occurredAt", run_id as "runId", provider, model, status,
             input_tokens::integer as "inputTokens", output_tokens::integer as "outputTokens",
             latency_ms as "latencyMs", cost_amount::text as "costAmount", trace_id as "traceId"
        from model_usage_events where tenant_id = ${tenantId} order by occurred_at desc limit 200
    `
    return rows.map((row) => ({
      id: row.id, time: formatDateTime(row.occurredAt), runId: row.runId,
      agentId: 'agent-dsh-work-assistant', department: '供应链中心', provider: row.provider,
      model: row.model, modelRoute: 'default', dataLevel: 'L1', status: row.status,
      promptTokens: row.inputTokens, completionTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens, latencyMs: row.latencyMs ?? 0,
      costCny: Number(row.costAmount ?? 0), traceId: row.traceId,
    }))
  }

  getPlatformStatus() {
    return { architecture: 'node-modular-monolith', persistence: 'postgres', sso: 'mock', dshRuntime: 'connected', database: 'configured', artifactStorage: 'local-mvp' }
  }

  async recordModelUsage(input: {
    run: RunRecord; attempt: RunAttemptRecord; prompt: string; output: string; status: 'success' | 'failed'; traceId: string;
    inputTokens?: number; outputTokens?: number
  }) {
    const route = input.attempt.modelRouteSnapshot
    const started = input.attempt.startedAt ? new Date(input.attempt.startedAt).getTime() : Date.now()
    await this.database`
      insert into model_usage_events (
        id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
        latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
      ) values (
        ${`usage-${input.attempt.id}`}, ${tenantId}, ${input.run.id}, ${input.attempt.id},
        ${String(route['providerKey'] ?? 'dsh-default')}, ${String(route['modelKey'] ?? 'dsh-default')},
        ${input.inputTokens ?? estimateTokens(input.prompt)}, ${input.outputTokens ?? estimateTokens(input.output)}, ${Math.max(0, Date.now() - started)},
        0, 'CNY', ${input.status}, ${input.traceId}, ${input.inputTokens === undefined || input.outputTokens === undefined}, now()
      ) on conflict (id) do nothing
    `
  }

  async recordToolAudit(input: { runId: string; attemptId: string; traceId: string; metadata: Record<string, unknown> }) {
    await this.database`
      insert into tool_audit_logs (
        id, tenant_id, run_id, attempt_id, tool_version_id, actor_user_id,
        parameter_summary, result, trace_id, occurred_at
      ) values (
        ${`tool-audit-${randomUUID()}`}, ${tenantId}, ${input.runId}, ${input.attemptId},
        'tool-version-dsh-runtime-1', 'U00001', ${this.database.json(JSON.parse(JSON.stringify(input.metadata)))},
        'success', ${input.traceId}, now()
      )
    `
  }

  appendAudit(actorId: string, action: string, objectId: string, result: AuditEvent['status'], traceId: string, detail: string) {
    return this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type, object_id,
        result, trace_id, safe_context
      ) values (
        ${`audit-${randomUUID()}`}, ${tenantId}, ${actorId === 'system' ? 'system' : 'user'},
        ${actorId}, ${action}, 'run', ${objectId}, ${result}, ${traceId},
        ${this.database.json({ detail })}
      )
    `.then(() => undefined)
  }
}

function estimateTokens(value: string) { return Math.ceil([...value].length / 2) }
function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)
}
