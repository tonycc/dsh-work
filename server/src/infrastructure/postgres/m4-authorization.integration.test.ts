import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let authorization: PostgresAuthorizationService
let agents: PostgresAgentService
let conversations: PostgresConversationRepository
let runtime: CapturingAuthorizationRuntime
let orchestration: RunOrchestrationService

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 5 })
  await runMigrations(database)
  authorization = new PostgresAuthorizationService(database)
  const tools = new PostgresToolConnectorService(database)
  const skills = new PostgresSkillService(database, undefined, tools)
  agents = new PostgresAgentService(database, undefined, skills, tools)
  conversations = new PostgresConversationRepository(database)
  runtime = new CapturingAuthorizationRuntime()
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    agents,
    undefined,
    authorization,
  )
})

after(async () => {
  if (orchestration) await orchestration.close()
  if (database) await database.end()
})

test('authorization is fail-closed and compiles the effective identity into Runtime Manifest', async () => {
  const allowed = await authorization.authorizeRuntime({
    userId: 'U00001',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.deepEqual(allowed.roleIds, ['role-employee'])
  assert.ok(allowed.permissions.includes('workbench:use'))
  assert.ok(allowed.dataScopes.includes('enterprise:authorized'))
  assert.ok(allowed.dataScopes.includes('workspace:authorized'))
  assert.ok(allowed.dataScopes.includes('domain:supply-chain'))

  const personalWorkspaceId = await conversations.resolveWorkspaceId(undefined, 'U00001')
  assert.equal(personalWorkspaceId, 'ws-personal-U00001')
  const personalAllowed = await authorization.authorizeRuntime({
    userId: 'U00001',
    workspaceId: personalWorkspaceId,
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.equal(personalAllowed.workspaceId, personalWorkspaceId)
  const [personalGrantCount] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_capability_grants
     where tenant_id = 'tenant-dsh-work' and workspace_id = ${personalWorkspaceId}
  `
  assert.equal(personalGrantCount?.count, 0)
  await assert.rejects(
    authorization.authorizeWorkbench({ userId: 'U00008', workspaceId: personalWorkspaceId }),
    /不是成员/,
  )

  const defaultSession = await orchestration.createSession({
    userId: 'U00001',
    title: '默认个人空间归属验证',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  assert.equal(defaultSession.workspaceId, personalWorkspaceId)

  await assert.rejects(
    authorization.authorizeRuntime({
      userId: 'U00008',
      workspaceId: 'ws-supply',
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
    /不是成员/,
  )

  const workspaceId = `ws-auth-${randomUUID().slice(0, 8)}`
  await database.begin(async transaction => {
    await transaction`
      insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
      values (${workspaceId}, 'tenant-dsh-work', '未授权能力空间', '用于验证能力授权默认拒绝', 'team', 'U00001', 'active')
    `
    await transaction`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values ('tenant-dsh-work', ${workspaceId}, 'U00001', 'owner', 'U00001')
    `
  })
  await assert.rejects(
    authorization.authorizeRuntime({
      userId: 'U00001',
      workspaceId,
      agentVersionId: 'agent-version-dsh-work-assistant-1',
    }),
    /未配置Agent授权/,
  )

  await assert.rejects(
    agents.createAgent({
      id: `agent-denied-${randomUUID().slice(0, 8)}`,
      name: '越权创建验证',
      description: '普通员工不能通过管理服务创建 Agent。',
      owner: '', department: '', visibility: '普通员工',
      roleIds: ['role-employee'], dataScopes: ['enterprise:authorized'],
      welcomeMessage: '', examplePrompts: ['测试权限'],
      systemPrompt: '这是一个不会被创建的越权测试 Agent 配置。',
      maxTokens: 12000, timeoutSeconds: 300,
      skills: [], tools: [], changeSummary: '越权测试', actor: '林岚',
    }),
    /不是平台管理员/,
  )

  await database`
    delete from data_scope_grants
     where tenant_id = 'tenant-dsh-work' and id = 'grant-role-employee-workspace'
  `
  try {
    await assert.rejects(
      authorization.authorizeRuntime({
        userId: 'U00001',
        agentVersionId: 'agent-version-dsh-work-assistant-1',
      }),
      /workspace:authorized/,
    )
  } finally {
    await database`
      insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
      values ('grant-role-employee-workspace', 'tenant-dsh-work', 'role', 'role-employee', 'capability', 'workspace:authorized')
      on conflict do nothing
    `
  }

  const session = await orchestration.createSession({
    userId: 'U00001',
    title: '授权清单验证',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await orchestration.startRun({
    userId: 'U00001',
    sessionId: session.id,
    prompt: '读取工作空间文件并整理重点',
    idempotencyKey: randomUUID(),
  })
  assert.ok(run)
  await waitForRun(run.id)
  const manifest = runtime.manifest(run.id)
  assert.deepEqual(manifest?.user_context.role_ids, ['role-employee'])
  assert.ok(manifest?.data_scopes.includes('domain:supply-chain'))
  assert.deepEqual(manifest?.skills, [{ id: 'skill-document', version: '1.0.0' }])
  assert.deepEqual(manifest?.tools, [{ id: 'read', version: '1.0.0' }])

  const [audit] = await database<{ blocked: number; success: number }[]>`
    select count(*) filter (where result = 'blocked')::integer as blocked,
           count(*) filter (where result = 'success')::integer as success
      from audit_events
     where tenant_id = 'tenant-dsh-work' and object_type = 'authorization'
  `
  assert.ok((audit?.blocked ?? 0) >= 3)
  assert.ok((audit?.success ?? 0) >= 1)
})

async function waitForRun(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === 'succeeded') return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待授权测试 Run 完成超时')
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
}

class CapturingAuthorizationRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'authorization-test',
      attemptDirectory: '/tmp/authorization-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '授权后进入队列')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '开始执行授权测试')
      this.emit(execution, 'assistant.completed', '授权测试完成。')
      execution.snapshot.status = 'completed'
      execution.snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', '授权测试完成')
      execution.resolveDone(structuredClone(execution.snapshot))
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return {
      status: 'healthy' as const,
      runtimeId: 'runtime-local-01',
      activeExecutions: 0,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: 'test',
    }
  }
  async close() {}
  manifest(runId: string) { return this.executions.get(runId)?.manifest }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: {},
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}
