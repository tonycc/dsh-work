import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
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
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let runtime: DeterministicRuntime
let runs: PostgresRunRepository
let conversations: PostgresConversationRepository
let content: PostgresContentService
let orchestration: RunOrchestrationService
let operations: PostgresOperationsService

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 6 })
  await runMigrations(database)
  runtime = new DeterministicRuntime()
  runs = new PostgresRunRepository(database)
  conversations = new PostgresConversationRepository(database)
  content = new PostgresContentService(database, `/tmp/dsh-work-m3-test-${randomUUID()}`)
  operations = new PostgresOperationsService(database)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    content,
    operations,
  )
})

after(async () => {
  await orchestration.close()
  await database.end()
})

test('real PostgreSQL orchestration persists the assistant result without publishing an Artifact', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 自动化闭环' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '生成 M3 自动化回答', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  const task = await waitForTask(created.id, 'succeeded')
  assert.match(task.messages.at(-1)?.content ?? '', /真实回答/)
  assert.equal(task.artifacts.length, 0)

  const events = await runs.readEventsAfterEvent('tenant-dsh-work', created.id)
  assert.deepEqual(events.map((event) => event.eventType), [
    'run.queued', 'run.started', 'assistant.delta', 'assistant.completed', 'run.completed',
  ])
  const resumed = await runs.readEventsAfterEvent('tenant-dsh-work', created.id, events.at(-2)?.id)
  assert.deepEqual(resumed.map((event) => event.eventType), ['run.completed'])

  const usage = await new PostgresOperationsService(database).getModelUsage()
  const usageRecord = usage.find((record) => record.runId === created.id)
  assert.ok(usageRecord && usageRecord.totalTokens > 0)
  assert.equal(usageRecord.employeeId, 'U00001')
  assert.equal(usageRecord.employeeName, '林岚')
  assert.equal(usageRecord.department, '供应链中心')
})

test('cancel and retry keep one Run and create a new immutable Attempt', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 取消重试' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '等待取消', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForTask(created.id, 'running')
  await orchestration.cancel(created.id, 'U00001')
  await waitForTask(created.id, 'cancelled')
  await orchestration.retry(created.id, 'U00001')
  await waitForTask(created.id, 'succeeded')
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${created.id}
  `
  assert.equal(count?.count, 2)
})

test('deleting a conversation archives it only after active Runs stop', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 删除对话' })
  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '等待取消', idempotencyKey: randomUUID(),
  })
  assert.ok(created)
  await waitForTask(created.id, 'running')

  await assert.rejects(
    conversations.archiveSession(session.id, 'U00001'),
    /请先停止当前运行/,
  )

  await orchestration.cancel(created.id, 'U00001')
  await waitForTask(created.id, 'cancelled')
  const archived = await conversations.archiveSession(session.id, 'U00001')

  assert.deepEqual(archived, { sessionId: session.id, title: 'M3 删除对话', archived: true })
  assert.equal(await conversations.getTask(created.id, 'U00001'), null)
  assert.equal((await conversations.listTasks('U00001')).some(task => task.sessionId === session.id), false)
  await assert.rejects(conversations.requireSession(session.id, 'U00001'), /不存在或不可访问/)
})

test('archiving a conversation and creating a Run are serialized by the Session lock', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 删除并发保护' })
  const archive = beginSessionArchive(session.id)

  await archive.checkedActiveRuns
  const rejectedCreation = assert.rejects(
    runs.createRun({
      tenantId: 'tenant-dsh-work',
      sessionId: session.id,
      requestedBy: 'U00001',
      idempotencyKey: randomUUID(),
    }),
    /Session 不存在或不可访问/,
  )
  archive.continueArchive()
  await archive.done
  await rejectedCreation

  const [persisted] = await database<{ count: number }[]>`
    select count(*)::integer as count from runs
     where tenant_id = 'tenant-dsh-work' and session_id = ${session.id}
  `
  assert.equal(persisted?.count, 0)
})

test('archiving a conversation and retrying a Run are serialized by the Session lock', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: 'M3 重试并发保护' })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  await runs.transitionRun(run.tenantId, run.id, 'cancelled')
  const archive = beginSessionArchive(session.id)

  await archive.checkedActiveRuns
  const rejectedAttempt = assert.rejects(
    runs.createAttempt({
      tenantId: run.tenantId,
      runId: run.id,
      manifest: { runId: run.id },
      manifestSha256: 'c'.repeat(64),
      modelRouteSnapshot: {},
    }),
    /所属 Session 已归档/,
  )
  archive.continueArchive()
  await archive.done
  await rejectedAttempt

  assert.equal((await runs.getRun(run.tenantId, run.id))?.status, 'cancelled')
  const [persisted] = await database<{ count: number }[]>`
    select count(*)::integer as count from run_attempts
     where tenant_id = 'tenant-dsh-work' and run_id = ${run.id}
  `
  assert.equal(persisted?.count, 0)
})

test('file safety gate blocks executable signatures and Tool audit is persisted', async () => {
  await assert.rejects(
    content.storeWorkspaceFile('ws-supply', '伪装文档.md', 'text/markdown', Buffer.from('MZ unsafe executable'), 'U00001'),
    /安全检查未通过/,
  )
  const run = await database<{ runId: string; attemptId: string }[]>`
    select r.id as "runId", a.id as "attemptId" from runs r
    join run_attempts a on a.tenant_id = r.tenant_id and a.run_id = r.id
    where r.tenant_id = 'tenant-dsh-work' and r.status = 'succeeded'
    order by r.created_at desc limit 1
  `
  const target = run[0]
  assert.ok(target)
  await operations.recordToolAudit({
    runId: target.runId,
    attemptId: target.attemptId,
    traceId: `trace-${target.runId}`,
    metadata: { tool_name: 'read', data_scope: 'workspace' },
  })
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from tool_audit_logs
     where tenant_id = 'tenant-dsh-work' and run_id = ${target.runId}
  `
  assert.ok((count?.count ?? 0) >= 1)
})

async function waitForTask(runId: string, expected: 'running' | 'succeeded' | 'cancelled') {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === expected) return task
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待 Run 状态超时：${expected}`)
}

function beginSessionArchive(sessionId: string) {
  let notifyChecked: () => void = () => undefined
  let continueArchive: () => void = () => undefined
  const checkedActiveRuns = new Promise<void>((resolve) => { notifyChecked = resolve })
  const continueSignal = new Promise<void>((resolve) => { continueArchive = resolve })
  const done = database.begin(async (transaction) => {
    await transaction`
      select id from sessions
       where tenant_id = 'tenant-dsh-work' and id = ${sessionId}
       for update
    `
    const [activeRun] = await transaction<{ id: string }[]>`
      select id from runs
       where tenant_id = 'tenant-dsh-work' and session_id = ${sessionId}
         and status in ('queued', 'running', 'cancel_requested')
       limit 1
    `
    if (activeRun) throw new Error(`测试前置条件失败，仍有活动 Run：${activeRun.id}`)
    notifyChecked()
    await continueSignal
    await transaction`
      update sessions set status = 'archived', last_active_at = now()
       where tenant_id = 'tenant-dsh-work' and id = ${sessionId}
    `
  })
  return { checkedActiveRuns, continueArchive, done }
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  resolve: (snapshot: RuntimeExecutionSnapshot) => void
  done: Promise<RuntimeExecutionSnapshot>
}

class DeterministicRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()
  private readonly attemptCounts = new Map<string, number>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>((resolve) => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id, attemptId: manifest.attempt_id, status: 'queued', acceptedAt: now,
      startedAt: null, endedAt: null, manifestSha256: 'test', attemptDirectory: '/tmp/test',
      errorCode: null, errorMessage: null,
    }
    const execution: Execution = { manifest, events: [], listeners: new Set(), snapshot, resolve: resolveDone, done }
    this.executions.set(manifest.run_id, execution)
    const count = (this.attemptCounts.get(manifest.run_id) ?? 0) + 1
    this.attemptCounts.set(manifest.run_id, count)
    this.emit(execution, 'run.queued', '已排队')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '已启动')
      if (manifest.input.message === '等待取消' && count === 1) return
      this.emit(execution, 'assistant.delta', 'M3 真实回答')
      this.emit(execution, 'assistant.completed', 'M3 真实回答')
      execution.snapshot.status = 'completed'
      this.emit(execution, 'run.completed', '已完成')
      this.finish(execution)
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

  async cancel(runId: string) {
    const execution = this.executions.get(runId)
    if (!execution || ['completed', 'cancelled', 'failed'].includes(execution.snapshot.status)) return { accepted: false }
    this.emit(execution, 'run.cancel_requested', '正在取消')
    execution.snapshot.status = 'cancelled'
    this.emit(execution, 'run.cancelled', '已取消')
    this.finish(execution)
    return { accepted: true }
  }

  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() { return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' } }
  async close() { return undefined }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], display: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(), run_id: execution.manifest.run_id, attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1, event_type: eventType, occurred_at: new Date().toISOString(),
      display_message: display, safe_metadata: {}, trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach((listener) => listener(event))
  }

  private finish(execution: Execution) {
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolve(structuredClone(execution.snapshot))
  }
}
