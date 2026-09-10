import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../../modules/identity/types.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { RunRevocationSweep } from '../../modules/run/run-revocation-sweep.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresWorkspaceMemberService } from '../../modules/workbench/application/postgres-workspace-member-service.ts'
import { streamRunEvents, registerConversationRoutes } from '../../http/workbench/conversation-routes.ts'
import { Router } from '../../http/router.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createServer, type Server } from 'node:http'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'
const testDatabaseName = `dsh_work_revocation_test_${randomUUID().replaceAll('-', '')}`
const adminUrl = new URL(databaseUrl)
adminUrl.pathname = '/postgres'

let adminDatabase: DatabaseClient
let database: DatabaseClient
let runtime: FakeRuntime
let authorization: PostgresAuthorizationService
let conversations: PostgresConversationRepository
let runs: PostgresRunRepository
let orchestration: RunOrchestrationService
let sweep: RunRevocationSweep
let members: PostgresWorkspaceMemberService
let agentMembers: PostgresWorkspaceAgentMemberService
let server: Server
let baseUrl = ''

before(async () => {
  adminDatabase = createDatabase({ url: adminUrl.toString(), maxConnections: 3 })
  await adminDatabase.unsafe(`create database "${testDatabaseName}"`)
  const testUrl = new URL(databaseUrl)
  testUrl.pathname = `/${testDatabaseName}`
  database = createDatabase({ url: testUrl.toString(), maxConnections: 10 })
  await runMigrations(database)
  // 本套件用共享的 runtime-local-01 跑真实调度（startRun / recoverAfterServiceRestart）。
  // claimAttempt 按 runtime 全局统计 status='running' 的 attempt 占用容量，而多个用例
  // 会直接落库 running 的 run/attempt 作为夹具，会跨用例耗尽默认容量 2，导致后续用例
  // 无法领取任务（表现为 waitFor 超时）。这里给测试 runtime 充足容量以隔离该相互影响。
  await database`
    update runtimes set capacity = 32
     where tenant_id = ${tenantId} and id = ${runtimeId}
  `

  runtime = new FakeRuntime()
  authorization = new PostgresAuthorizationService(database)
  conversations = new PostgresConversationRepository(database)
  runs = new PostgresRunRepository(database)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    authorization,
  )
  sweep = new RunRevocationSweep(database, runs, orchestration, authorization)
  members = new PostgresWorkspaceMemberService(database, authorization)
  agentMembers = new PostgresWorkspaceAgentMemberService(
    database,
    authorization,
    undefined as unknown as PostgresAgentService,
  )

  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerConversationRoutes(
    router,
    conversations,
    orchestration,
    runs,
    undefined as unknown as PostgresAgentService,
    authorization,
    undefined,
    undefined,
    agentMembers,
  )
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (orchestration) await orchestration.close()
  if (database) await database.end()
  if (adminDatabase) {
    await adminDatabase.unsafe(`drop database "${testDatabaseName}" with (force)`)
    await adminDatabase.end()
  }
})

// ---------------------------------------------------------------------------
// 5.1 systemCancelRun 幂等收敛
// ---------------------------------------------------------------------------

test('systemCancelRun：queued 运行直接取消并写入说明事件', async () => {
  const ws = uniqueWorkspace('syscancel-queued')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '收权排队负责人')
  await seedUser(userId, '收权排队成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  const cancelled = await orchestration.systemCancelRun(runId, 'system_revoke', '成员已被移出团队空间')
  assert.equal(cancelled.status, 'cancelled')
  const run = await runRow(runId)
  assert.equal(run.status, 'cancelled')
  const attempt = await attemptRow(`${runId}-attempt`)
  assert.equal(attempt.status, 'cancelled')
  const events = await runEventRows(runId)
  const note = events.find(event => event.eventType === 'run.cancelled')
  assert.ok(note, '应当写入取消说明事件')
  assert.equal(note.displayMessage, '授权已撤销，任务未执行')
  assert.equal(note.safeMetadata['cause'], 'system_revoke')
  assert.equal(note.safeMetadata['reason'], '成员已被移出团队空间')
  assert.equal(runtime.cancels.length, 1)
  assert.equal(runtime.cancels[0]?.runId, runId)
  assert.equal(runtime.cancels[0]?.requestedBy, 'system')
  assert.equal(runtime.cancels[0]?.cause, 'system_revoke')
})

test('systemCancelRun：running 运行调用 runtime.cancel 并携带 system_revoke 原因，事件收敛到 cancelled', async () => {
  const ws = uniqueWorkspace('syscancel-running')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '收权运行负责人')
  await seedUser(userId, '收权运行成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  runtime.holdCompletions = true
  const started = await orchestration.startRun({
    userId,
    sessionId,
    prompt: '收权运行测试',
    idempotencyKey: `${runIdPrefix(ws)}-syscancel-running`,
  })
  if (!started) throw new Error('Run 创建失败')
  await waitFor(async () => (await runRow(started.id)).status === 'running', 'run 进入 running')

  await orchestration.systemCancelRun(started.id, 'system_revoke', 'Agent 成员已停用')
  const cancel = runtime.cancels.find(entry => entry.runId === started.id)
  assert.ok(cancel, '应当调用 runtime.cancel')
  assert.equal(cancel.requestedBy, 'system')
  assert.equal(cancel.cause, 'system_revoke')
  await waitFor(async () => (await runRow(started.id)).status === 'cancelled', 'running run 收敛到 cancelled')
})

test('systemCancelRun：终态运行幂等返回，不调用 runtime.cancel', async () => {
  const ws = uniqueWorkspace('syscancel-terminal')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '收权终态负责人')
  await seedUser(userId, '收权终态成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'succeeded', agentVersionId: versionId, workspaceId: ws })

  const cancelsBefore = runtime.cancels.length
  const unchanged = await orchestration.systemCancelRun(runId, 'system_revoke', '成员已被移出团队空间')
  assert.equal(unchanged.status, 'succeeded')
  assert.equal(runtime.cancels.length, cancelsBefore, '终态运行不得调用 runtime.cancel')
  assert.equal((await runRow(runId)).status, 'succeeded')
})

// ---------------------------------------------------------------------------
// 5.1.3 收权清扫范围
// ---------------------------------------------------------------------------

test('收权清扫：member_removed 取消该成员在本空间的排队与运行中任务，不影响他人与其他空间', async () => {
  const ws = uniqueWorkspace('sweep-member')
  const otherWs = uniqueWorkspace('sweep-member-other')
  const ownerId = `${ws}-owner`
  const revokedId = `${ws}-revoked`
  const peerId = `${ws}-peer`
  const otherUserId = `${ws}-other-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '清扫负责人')
  await seedUser(revokedId, '清扫被移除成员')
  await seedUser(peerId, '清扫同空间成员')
  await seedUser(otherUserId, '清扫其他空间成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: revokedId, role: 'member' }, { userId: peerId, role: 'member' }])
  await createTeamWorkspace(otherWs, [{ userId: otherUserId, role: 'owner' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  await grantAgentVersion(otherWs, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, revokedId, versionId)
  const otherSessionId = `${otherWs}-session`
  await createSession(otherSessionId, otherWs, otherUserId, versionId)

  const queuedRunId = `${ws}-run-queued`
  await createRunWithAttempt({ id: queuedRunId, sessionId, requestedBy: revokedId, status: 'queued', agentVersionId: versionId, workspaceId: ws })
  const terminalRunId = `${ws}-run-terminal`
  await createRunWithAttempt({ id: terminalRunId, sessionId, requestedBy: revokedId, status: 'succeeded', agentVersionId: versionId, workspaceId: ws })
  const peerRunId = `${ws}-run-peer`
  await createSession(`${ws}-peer-session`, ws, peerId, versionId)
  await createRunWithAttempt({ id: peerRunId, sessionId: `${ws}-peer-session`, requestedBy: peerId, status: 'queued', agentVersionId: versionId, workspaceId: ws })
  const otherRunId = `${otherWs}-run`
  await createRunWithAttempt({ id: otherRunId, sessionId: otherSessionId, requestedBy: otherUserId, status: 'queued', agentVersionId: versionId, workspaceId: otherWs })

  // 被移除成员还有一条真实执行的 running 任务（经过调度器与订阅，事件可收敛）。
  runtime.holdCompletions = true
  const runningSessionId = `${ws}-running-session`
  await createSession(runningSessionId, ws, revokedId, versionId)
  const running = await orchestration.startRun({
    userId: revokedId,
    sessionId: runningSessionId,
    prompt: '收权清扫运行中任务',
    idempotencyKey: `${runIdPrefix(ws)}-sweep-running`,
  })
  if (!running) throw new Error('Run 创建失败')
  await waitFor(async () => (await runRow(running.id)).status === 'running', 'run 进入 running')

  // 事件是触发提示，当前授权状态才是事实来源：成员必须真的已被移出，否则
  // isRevocationEffective 的当前状态门会（正确地）跳过清扫。
  // members.removeMember 自身会写入 member_removed 撤权事件并推进修订号，
  // 这里不再手工重复插入（会撞 workspace_revocation_events 去重键）。
  await members.removeMember(ws, revokedId, ownerId)
  await sweep.sweepOnce()

  await waitFor(async () => (await runRow(queuedRunId)).status === 'cancelled', '排队任务被取消')
  assert.equal((await runRow(queuedRunId)).status, 'cancelled')
  await waitFor(async () => (await runRow(running.id)).status === 'cancelled', '运行中任务被取消')
  assert.equal((await runRow(running.id)).status, 'cancelled')
  assert.equal((await runRow(peerRunId)).status, 'queued', '同空间其他成员的运行不受影响')
  assert.equal((await runRow(otherRunId)).status, 'queued', '其他空间的运行不受影响')
  assert.equal((await runRow(terminalRunId)).status, 'succeeded', '终态运行不受影响')
  const events = await revocationEventRows(ws)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.status, 'processed')
  assert.ok(events[0]?.processedAt)
})

test('收权清扫：agent_disabled 只取消锁定在该 Agent 成员版本上的运行', async () => {
  const ws = uniqueWorkspace('sweep-agent')
  const otherWs = uniqueWorkspace('sweep-agent-other')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionA = `${ws}-version-a`
  const versionB = `${ws}-version-b`
  await seedUser(ownerId, '清扫 Agent 负责人')
  await seedUser(userId, '清扫 Agent 成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  // 对照空间：请求人必须是该空间的合法成员，否则修订号全量复核会（正确地）
  // 以「非成员」为由取消该运行，掩盖本用例真正要验证的跨空间隔离。
  await createTeamWorkspace(otherWs, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionA, 'a')
  await seedAgent(ws, versionB, 'b')
  await grantAgentVersion(ws, versionA)
  await grantAgentVersion(ws, versionB)
  await grantAgentVersion(otherWs, versionA)
  const memberA = `${ws}-wam-a`
  const memberB = `${ws}-wam-b`
  await addAgentMemberRow(ws, memberA, `${ws}-agent-a`, versionA)
  await addAgentMemberRow(ws, memberB, `${ws}-agent-b`, versionB)
  await addAgentMemberRow(otherWs, `${otherWs}-wam-a`, `${ws}-agent-a`, versionA)

  const sessionA = `${ws}-session-a`
  const sessionB = `${ws}-session-b`
  const otherSession = `${otherWs}-session`
  await createSession(sessionA, ws, userId, versionA)
  await createSession(sessionB, ws, userId, versionB)
  await createSession(otherSession, otherWs, userId, versionA)
  const runA = `${ws}-run-a`
  const runB = `${ws}-run-b`
  const runOther = `${otherWs}-run-a`
  await createRunWithAttempt({ id: runA, sessionId: sessionA, requestedBy: userId, status: 'queued', agentVersionId: versionA, workspaceId: ws })
  await createRunWithAttempt({ id: runB, sessionId: sessionB, requestedBy: userId, status: 'queued', agentVersionId: versionB, workspaceId: ws })
  await createRunWithAttempt({ id: runOther, sessionId: otherSession, requestedBy: userId, status: 'queued', agentVersionId: versionA, workspaceId: otherWs })

  // 停用 Agent 成员 A：状态置 disabled、授权集合撤销、写入事件并推进修订号。
  await database`
    update workspace_agent_members set status = 'disabled'
     where tenant_id = ${tenantId} and workspace_id = ${ws} and id = ${memberA}
  `
  await database`
    delete from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${ws}
       and capability_type = 'agent' and capability_version_id = ${versionA}
  `
  await insertRevocationEvent(ws, ownerId, 'agent_disabled', { agentMemberId: memberA, agentId: `${ws}-agent-a`, by: ownerId })
  await bumpRevision(ws)
  await sweep.sweepOnce()

  await waitFor(async () => (await runRow(runA)).status === 'cancelled', '锁定版本的运行被取消')
  assert.equal((await runRow(runA)).status, 'cancelled')
  assert.equal((await runRow(runB)).status, 'queued', '其他 Agent 版本的运行不受影响')
  assert.equal((await runRow(runOther)).status, 'queued', '其他空间的运行不受影响')
  const events = await revocationEventRows(ws)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.status, 'processed')
})

// ---------------------------------------------------------------------------
// 5.1.4 事件消费者：处理、重放与当前状态门
// ---------------------------------------------------------------------------

test('消费者：pending 事件处理后取消运行并标记 processed，重放安全', async () => {
  const ws = uniqueWorkspace('consumer-replay')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '消费者负责人')
  await seedUser(userId, '消费者成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  // 事件是触发提示，当前授权状态才是事实来源：成员必须真的已被移出，否则
  // isRevocationEffective 的当前状态门会（正确地）跳过清扫，用例就测不到消费链路。
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${userId}`
  await insertRevocationEvent(ws, userId, 'member_removed', { by: ownerId })
  await bumpRevision(ws)
  await sweep.sweepOnce()

  assert.equal((await runRow(runId)).status, 'cancelled')
  const events = await revocationEventRows(ws)
  assert.equal(events[0]?.status, 'processed')

  const cancelsAfterFirst = runtime.cancels.length
  await sweep.sweepOnce()
  assert.equal(runtime.cancels.length, cancelsAfterFirst, '重放不得重复取消')
  assert.equal((await runRow(runId)).status, 'cancelled')
  assert.equal((await revocationEventRows(ws))[0]?.status, 'processed')
})

test('消费者关键场景：disable→enable→disable 相同 payload 只产生一行事件，第二次停用的运行仍被取消（当前状态门）', async () => {
  const ws = uniqueWorkspace('consumer-critical')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '关键场景负责人')
  await seedUser(userId, '关键场景成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const memberId = `${ws}-wam`
  await addAgentMemberRow(ws, memberId, `${ws}-agent`, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  // 通过真实服务执行 disable → enable → disable，三次 payload 完全一致。
  await agentMembers.updateAgentMember(ws, memberId, 'disable', ownerId)
  await agentMembers.updateAgentMember(ws, memberId, 'enable', ownerId)
  await agentMembers.updateAgentMember(ws, memberId, 'disable', ownerId)

  // 事件表按 (workspace_id, user_id, kind, payload_hash) 去重：只存在一行。
  const events = await revocationEventRows(ws)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.kind, 'agent_disabled')
  assert.equal(events[0]?.status, 'pending')

  // 消费者处理该事件时必须按当前状态复核：第二次停用后 wam 仍 disabled，
  // 即使只有一行事件，运行也必须被取消。
  await sweep.sweepOnce()
  assert.equal((await runRow(runId)).status, 'cancelled')
  assert.equal((await revocationEventRows(ws))[0]?.status, 'processed')
})

test('消费者当前状态门：重新启用后跳过清扫', async () => {
  const ws = uniqueWorkspace('consumer-gate-agent')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '状态门负责人')
  await seedUser(userId, '状态门成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const memberId = `${ws}-wam`
  await addAgentMemberRow(ws, memberId, `${ws}-agent`, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  await agentMembers.updateAgentMember(ws, memberId, 'disable', ownerId)
  await agentMembers.updateAgentMember(ws, memberId, 'enable', ownerId)
  await sweep.sweepOnce()

  assert.equal((await runRow(runId)).status, 'queued', '已重新启用的 Agent 成员不得触发取消')
  assert.equal((await revocationEventRows(ws))[0]?.status, 'processed')
})

test('消费者当前状态门：成员重新加入后跳过清扫', async () => {
  const ws = uniqueWorkspace('consumer-gate-member')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '成员状态门负责人')
  await seedUser(userId, '成员状态门用户')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  await members.removeMember(ws, userId, ownerId)
  await members.addMember(ws, userId, 'member', ownerId)
  await sweep.sweepOnce()

  assert.equal((await runRow(runId)).status, 'queued', '已重新加入的成员不得触发取消')
  assert.equal((await revocationEventRows(ws))[0]?.status, 'processed')
})

test('team_auth_revision 兜底：无事件行的修订变更仍触发全量复核并取消失权运行', async () => {
  const ws = uniqueWorkspace('consumer-revision')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '修订兜底负责人')
  await seedUser(userId, '修订兜底成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const memberId = `${ws}-wam`
  await addAgentMemberRow(ws, memberId, `${ws}-agent`, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  // 模拟「事件行因去重未产生」的收权：仅状态与授权集合变化 + 修订号推进。
  await database`
    update workspace_agent_members set status = 'disabled'
     where tenant_id = ${tenantId} and workspace_id = ${ws} and id = ${memberId}
  `
  await database`
    delete from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${ws}
       and capability_type = 'agent' and capability_version_id = ${versionId}
  `
  await bumpRevision(ws)
  assert.equal((await revocationEventRows(ws)).length, 0)

  await sweep.sweepOnce()
  await waitFor(async () => (await runRow(runId)).status === 'cancelled', '修订兜底取消运行')
  assert.equal((await runRow(runId)).status, 'cancelled')
})

// ---------------------------------------------------------------------------
// 5.2 执行前复核
// ---------------------------------------------------------------------------

test('执行前复核：团队运行成员被移除后置 failed 且不调用 Runtime（含 run_events 说明）', async () => {
  const ws = uniqueWorkspace('recheck-team')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '复核团队负责人')
  await seedUser(userId, '复核团队成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  // 领取前收权：移除成员 + 撤销授权 + 推进修订号。
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${userId}`
  await database`delete from workspace_capability_grants where tenant_id = ${tenantId} and workspace_id = ${ws} and capability_type = 'agent' and capability_version_id = ${versionId}`
  await bumpRevision(ws)

  runtime.holdCompletions = true
  await orchestration.recoverAfterServiceRestart()
  await waitFor(async () => (await runRow(runId)).status === 'failed', '复核失败置 failed')

  assert.equal(runtime.executions.has(runId), false, '不得调用 Runtime')
  assert.equal((await attemptRow(`${runId}-attempt`)).errorCode, 'AUTHORIZATION_REVOKED')
  const events = await runEventRows(runId)
  const note = events.find(event => event.eventType === 'run.failed')
  assert.ok(note, '应当写入复核失败说明事件')
  assert.equal(note.displayMessage, '授权已撤销，任务未执行')
  assert.equal(typeof note.safeMetadata['reason'], 'string')
})

test('执行前复核：个人空间运行不复核，正常执行', async () => {
  const prefix = uniqueWorkspace('recheck-personal')
  const userId = `${prefix}-owner`
  const versionId = `${prefix}-version`
  await seedUser(userId, '复核个人空间用户')
  // 0013 的 users_personal_workspace_provisioning 触发器在插入 users 时已自动
  // 创建个人空间；直接使用它，不要再次插入（会撞 one_personal_workspace_per_user）。
  const ws = await database<{ id: string }[]>`
    select id from workspaces
     where tenant_id = ${tenantId} and workspace_type = 'personal' and created_by = ${userId}
  `.then(rows => {
    if (!rows[0]) throw new Error(`个人空间未自动创建：${userId}`)
    return rows[0].id
  })
  await seedAgent(prefix, versionId)
  const sessionId = `${prefix}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${prefix}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'queued', agentVersionId: versionId, workspaceId: ws })

  runtime.holdCompletions = false
  await orchestration.recoverAfterServiceRestart()
  await waitFor(async () => runtime.executions.has(runId), '个人空间运行进入 Runtime')
  await waitFor(async () => (await runRow(runId)).status === 'succeeded', '个人空间运行正常完成')
  assert.equal(runtime.executions.has(runId), true)
})

// ---------------------------------------------------------------------------
// 5.3 SSE 拦截
// ---------------------------------------------------------------------------

test('SSE：观看者被移出团队空间后流终止且不再交付后续事件', async () => {
  const ws = uniqueWorkspace('sse-removed')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, 'SSE 负责人')
  await seedUser(userId, 'SSE 成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'running', agentVersionId: versionId, workspaceId: ws })
  const firstEvent = await appendRunEvent(runId, `${runId}-attempt`, 1, 'assistant.delta', '第一批内容')

  const response = new MemorySseResponse()
  const stream = streamRunEvents(response, undefined, runId, runs, 20, 60_000, {
    workspaceId: ws,
    userId,
    authorization,
  })
  await waitFor(() => response.body.includes(firstEvent), '第一批内容交付')

  await members.removeMember(ws, userId, ownerId)
  const lateEvent = await appendRunEvent(runId, `${runId}-attempt`, 2, 'assistant.delta', '撤权后的内容')

  await Promise.race([
    stream,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('SSE 流未在撤权后终止')), 5_000)),
  ])
  assert.equal(response.ended, true)
  assert.equal(response.body.includes(lateEvent), false, '撤权后的内容不得交付')
  assert.equal(response.body.includes(firstEvent), true)
})

test('SSE：授权缓存按修订号失效（同修订号缓存命中，修订变更立即拒绝）', async () => {
  const ws = uniqueWorkspace('sse-cache')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, 'SSE 缓存负责人')
  await seedUser(userId, 'SSE 缓存成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'running', agentVersionId: versionId, workspaceId: ws })
  const firstEvent = await appendRunEvent(runId, `${runId}-attempt`, 1, 'assistant.delta', '缓存第一批')

  const response = new MemorySseResponse()
  const stream = streamRunEvents(response, undefined, runId, runs, 20, 60_000, {
    workspaceId: ws,
    userId,
    authorization,
    ttlMs: 60_000,
  })
  await waitFor(() => response.body.includes(firstEvent), '首批内容交付')

  // 同修订号内直接删除成员（不推进修订号）：授权缓存命中，批次仍可交付。
  await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${userId}`
  const cachedEvent = await appendRunEvent(runId, `${runId}-attempt`, 2, 'assistant.delta', '缓存命中批次')
  await waitFor(() => response.body.includes(cachedEvent), '同修订号缓存命中，内容继续交付')

  // 修订号推进后缓存立即失效：下一批写出前的检查新鲜复核并拒绝，流终止。
  await bumpRevision(ws)
  const deniedEvent = await appendRunEvent(runId, `${runId}-attempt`, 3, 'assistant.delta', '修订失效批次')
  await Promise.race([
    stream,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('修订变更后 SSE 流未终止')), 5_000)),
  ])
  assert.equal(response.ended, true)
  assert.equal(response.body.includes(deniedEvent), false, '修订变更后的批次不得交付')
})

test('SSE 写出竞态：检查通过后、写出前提交的撤权不得交付该批次（AC-09）', async () => {
  const ws = uniqueWorkspace('sse-race')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, 'SSE 竞态负责人')
  await seedUser(userId, 'SSE 竞态成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'running', agentVersionId: versionId, workspaceId: ws })
  const deliveredEvent = await appendRunEvent(runId, `${runId}-attempt`, 1, 'assistant.delta', '竞态第一批')

  // 模拟「复核通过后、写出前」的撤权提交：读取第二批次的同一刻提交成员移除 +
  // 修订号推进。第二批次必须在此之后才写入 run_events，否则首轮全量读取会把
  // 「撤权后」的内容当成在途批次交付，竞态窗口就不再存在。
  let racedEventWritten = false
  let racedEventId = ''
  const racingRuns = {
    async readEventsAfterEvent(tenant: string, run: string, cursor?: string) {
      if (cursor === deliveredEvent && !racedEventWritten) {
        racedEventWritten = true
        await database`delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${ws} and user_id = ${userId}`
        await bumpRevision(ws)
        racedEventId = await appendRunEvent(run, `${runId}-attempt`, 2, 'assistant.delta', '竞态第二批次')
      }
      return runs.readEventsAfterEvent(tenant, run, cursor)
    },
    getRun: (tenant: string, run: string) => runs.getRun(tenant, run),
  }

  const response = new MemorySseResponse()
  const stream = streamRunEvents(response, undefined, runId, racingRuns, 20, 60_000, {
    workspaceId: ws,
    userId,
    authorization,
  })
  await waitFor(() => response.body.includes(deliveredEvent), '第一批内容交付')

  await Promise.race([
    stream,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('竞态撤权后 SSE 流未终止')), 5_000)),
  ])
  assert.equal(racedEventWritten, true, '竞态撤权应当在第二批次读取时提交')
  assert.equal(response.ended, true)
  assert.equal(response.body.includes(racedEventId), false, '撤权提交后的批次不得交付')
})

test('SSE HTTP 路由：成员被移出团队空间后事件流终止', async () => {
  const ws = uniqueWorkspace('sse-http')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, 'SSE HTTP 负责人')
  await seedUser(userId, 'SSE HTTP 成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)
  const runId = `${ws}-run`
  await createRunWithAttempt({ id: runId, sessionId, requestedBy: userId, status: 'running', agentVersionId: versionId, workspaceId: ws })
  const firstEvent = await appendRunEvent(runId, `${runId}-attempt`, 1, 'assistant.delta', 'HTTP 流第一批')

  const response = await fetch(`${baseUrl}/api/workbench/v1/runs/${runId}/events`, {
    headers: { 'x-test-user-id': userId },
  })
  assert.equal(response.status, 200)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('SSE 响应没有 body')
  const collector = collectStream(reader)
  await waitFor(() => collector.text().includes(firstEvent), 'HTTP 流交付首批内容')

  await members.removeMember(ws, userId, ownerId)
  await appendRunEvent(runId, `${runId}-attempt`, 2, 'assistant.delta', 'HTTP 流撤权后内容')

  await Promise.race([
    collector.done(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('HTTP SSE 流未在撤权后终止')), 5_000)),
  ])
  assert.equal(collector.text().includes('HTTP 流撤权后内容'), false, '撤权后的内容不得交付')
})

// ---------------------------------------------------------------------------
// 5.3 领取与执行竞态（AC-09）
// ---------------------------------------------------------------------------

test('执行前复核通过后、调用 Runtime 前被系统取消的运行不得进入 Runtime', async () => {
  const ws = uniqueWorkspace('claim-exec-race')
  const ownerId = `${ws}-owner`
  const userId = `${ws}-user`
  const versionId = `${ws}-version`
  await seedUser(ownerId, '领取竞态负责人')
  await seedUser(userId, '领取竞态成员')
  await createTeamWorkspace(ws, [{ userId: ownerId, role: 'owner' }, { userId: userId, role: 'member' }])
  await seedAgent(ws, versionId)
  await grantAgentVersion(ws, versionId)
  const sessionId = `${ws}-session`
  await createSession(sessionId, ws, userId, versionId)

  // 在「复核通过 → runtime.execute」之间插入撤权：复核判定通过后、守卫读取状态前
  // 同步完成成员移除与系统取消收敛，精确命中 executeClaimed 的终态守卫。
  let revoked = false
  const racingAuthorization = new Proxy(authorization, {
    get(target, property, receiver) {
      if (property === 'authorizeTeamRunExecution') {
        return async (input: { userId: string; workspaceId: string; agentVersionId: string }) => {
          const decision = await target.authorizeTeamRunExecution(input)
          if (!revoked) {
            revoked = true
            await members.removeMember(ws, userId, ownerId)
            await sweep.sweepOnce()
          }
          return decision
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as PostgresAuthorizationService
  const racingOrchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    undefined,
    undefined,
    undefined,
    undefined,
    racingAuthorization,
  )

  runtime.holdCompletions = true
  try {
    const started = await racingOrchestration.startRun({
      userId,
      sessionId,
      prompt: '领取与执行竞态',
      idempotencyKey: `${runIdPrefix(ws)}-claim-exec-race`,
    })
    if (!started) throw new Error('Run 创建失败')
    await waitFor(async () => ['cancelled', 'failed', 'succeeded'].includes((await runRow(started.id)).status), '运行收敛为终态')

    assert.equal(revoked, true, '撤权应当在调用 Runtime 前提交')
    assert.equal(runtime.executions.has(started.id), false, '被取消的运行不得进入 Runtime')
    const events = await runEventRows(started.id)
    const cancelledEvents = events.filter(event => event.eventType === 'run.cancelled')
    assert.equal(cancelledEvents.length, 1, '系统取消说明事件只应写入一次')
  } finally {
    await racingOrchestration.close()
  }
})

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId,
      name: userId,
      title: '员工',
      department: '测试部门',
      avatarText: '测',
      role: 'employee',
      dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

function uniqueWorkspace(prefix: string) {
  return `ws-t5-${prefix}-${randomUUID().slice(0, 8)}`
}

function runIdPrefix(ws: string) {
  return ws.replaceAll('-', '')
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status,
      identity_provider, business_user
    ) values (
      ${id}, ${tenantId}, ${`directory:${id}`}, ${displayName},
      null, 'active', 'ai-hub', true
    )
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local')
    on conflict do nothing
  `
}

async function createTeamWorkspace(workspaceId: string, members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T5 收权测试团队空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function seedAgent(workspacePrefix: string, versionId: string, suffix = '') {
  const agentId = `${workspacePrefix}-agent${suffix ? `-${suffix}` : ''}`
  await database`
    insert into agents (
      id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
      status, active_version_id, allow_workspace_join
    ) values (
      ${agentId}, ${tenantId}, 'T5 测试 Agent', 'T5 收权流水线集成测试。',
      '', 'U00008', 'U00008', 'published', null, true
    )
  `
  await database`
    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
      timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
    ) values (
      ${versionId}, ${tenantId}, ${agentId}, '1.0.0', 'T5 测试 Agent', 'T5 收权测试版本。',
      '', ${database.json([] as string[])}, '你是 T5 集成测试 Agent。',
      ${database.json(['role-employee'] as string[])}, ${database.json(['enterprise:authorized'] as string[])},
      12000, 300, ${database.json([] as string[])}, ${database.json([] as string[])},
      'published', 'U00008', 'T5 测试版本'
    )
  `
  await database`
    update agents set active_version_id = ${versionId}
     where tenant_id = ${tenantId} and id = ${agentId}
  `
  return { agentId, versionId }
}

async function grantAgentVersion(workspaceId: string, versionId: string) {
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, ${workspaceId}, 'agent', ${versionId})
    on conflict do nothing
  `
}

async function addAgentMemberRow(workspaceId: string, memberId: string, agentId: string, versionId: string) {
  await database`
    insert into workspace_agent_members (
      id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by
    ) values (
      ${memberId}, ${tenantId}, ${workspaceId}, ${agentId}, ${versionId}, 'available', 'U00008'
    )
  `
}

async function createSession(sessionId: string, workspaceId: string, userId: string, agentVersionId: string) {
  await database`
    insert into sessions (
      id, tenant_id, workspace_id, created_by, agent_version_id, title, status
    ) values (
      ${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, ${agentVersionId},
      'T5 收权测试会话', 'active'
    )
  `
}

async function createRunWithAttempt(input: {
  id: string
  sessionId: string
  requestedBy: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  agentVersionId: string
  workspaceId: string
}) {
  const attemptId = `${input.id}-attempt`
  const manifest = {
    manifest_version: '1.0',
    run_id: input.id,
    attempt_id: attemptId,
    session_id: input.sessionId,
    workspace_id: input.workspaceId,
    agent_version_id: input.agentVersionId,
    user_context: { user_id: input.requestedBy, tenant_id: tenantId, role_ids: [] },
  }
  // runs_current_attempt_fk is deferrable — both rows must exist at commit.
  await database.begin(async transaction => {
    await transaction`
      insert into runs (
        id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id
      ) values (
        ${input.id}, ${tenantId}, ${input.sessionId}, ${input.requestedBy},
        ${`idem-${input.id}`}, ${input.status}, ${attemptId}
      )
    `
    await transaction`
      insert into run_attempts (
        id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256,
        model_route_snapshot, status
      ) values (
        ${attemptId}, ${tenantId}, ${input.id}, 1, ${runtimeId},
        ${transaction.json(manifest)}, 'revocation-test', ${transaction.json({})},
        ${input.status}
      )
    `
  })
  return { runId: input.id, attemptId }
}

async function appendRunEvent(runId: string, attemptId: string, sequence: number, eventType: string, displayMessage: string) {
  const id = `event-${runId}-${sequence}`
  await runs.appendEvent({
    id,
    tenantId,
    runId,
    attemptId,
    sequence,
    eventType,
    displayMessage,
    safeMetadata: {},
    traceId: `trace-${runId}`,
    occurredAt: new Date().toISOString(),
  })
  return id
}

async function insertRevocationEvent(workspaceId: string, userId: string, kind: string, payload: Record<string, string>) {
  await database`
    insert into workspace_revocation_events (
      id, tenant_id, workspace_id, user_id, kind, payload, payload_hash
    ) values (
      ${`wrev-test-${randomUUID()}`}, ${tenantId}, ${workspaceId}, ${userId}, ${kind},
      ${database.json(payload)}, md5(${database.json(payload)}::text)
    )
  `
}

async function bumpRevision(workspaceId: string) {
  await database`
    update workspaces set team_auth_revision = team_auth_revision + 1
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
}

async function runRow(runId: string) {
  const [row] = await database<{ status: string }[]>`
    select status from runs where tenant_id = ${tenantId} and id = ${runId}
  `
  if (!row) throw new Error(`Run 不存在：${runId}`)
  return row
}

async function attemptRow(attemptId: string) {
  const [row] = await database<{ status: string; errorCode: string | null }[]>`
    select status, error_code as "errorCode" from run_attempts
     where tenant_id = ${tenantId} and id = ${attemptId}
  `
  if (!row) throw new Error(`Attempt 不存在：${attemptId}`)
  return row
}

async function runEventRows(runId: string) {
  const rows = await database<{ eventType: string; displayMessage: string | null; safeMetadata: Record<string, unknown> }[]>`
    select event_type as "eventType", display_message as "displayMessage", safe_metadata as "safeMetadata"
      from run_events
     where tenant_id = ${tenantId} and run_id = ${runId}
     order by sequence asc
  `
  return rows
}

async function revocationEventRows(workspaceId: string) {
  const rows = await database<{ kind: string; status: string; processedAt: Date | null }[]>`
    select kind, status, processed_at as "processedAt"
      from workspace_revocation_events
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by created_at asc
  `
  return rows
}

async function waitFor(condition: () => Promise<boolean> | boolean, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${label}`)
}

class MemorySseResponse extends EventEmitter {
  body = ''
  ended = false

  writeHead() { return this }
  flushHeaders() { return undefined }
  write(chunk: string) {
    this.body += chunk
    return true
  }
  end() {
    this.ended = true
    return this
  }
}

function collectStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let text = ''
  let resolveDone: () => void = () => undefined
  const done = new Promise<void>(resolve => { resolveDone = resolve })
  void (async () => {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value, { stream: true })
      }
    } finally {
      resolveDone()
    }
  })()
  return { text: () => text, done: () => done }
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
  terminal: boolean
  snapshot: RuntimeExecutionSnapshot
}

class FakeRuntime implements AgentRuntimePort {
  readonly executions = new Map<string, Execution>()
  readonly cancels: Array<{ runId: string; requestedBy: string; cause?: string }> = []
  holdCompletions = true

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
      manifestSha256: 'revocation-test',
      attemptDirectory: '/tmp/revocation-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution: Execution = { manifest, events: [], listeners: new Set(), done, resolveDone, terminal: false, snapshot }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '任务已进入 Runtime 队列', {})
    setTimeout(() => {
      if (execution.terminal) return
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', 'Runtime 开始执行', {})
      if (!this.holdCompletions) {
        this.emit(execution, 'assistant.completed', '测试执行完成。', {})
        this.emit(execution, 'run.completed', '任务执行完成', {})
        this.finish(execution, 'completed')
      }
    }, 5)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error(`Run not found: ${runId}`)
    for (const event of execution.events) listener(structuredClone(event))
    execution.listeners.add(listener)
    return () => { execution.listeners.delete(listener) }
  }

  async cancel(runId: string, requestedBy: string, cancelCause?: 'user' | 'system_revoke') {
    this.cancels.push({ runId, requestedBy, cause: cancelCause })
    const execution = this.executions.get(runId)
    if (!execution || execution.terminal) return { accepted: false }
    execution.snapshot.status = 'cancel_requested'
    this.emit(execution, 'run.cancel_requested', '正在取消任务', { cause: cancelCause ?? 'user' })
    this.emit(execution, 'run.cancelled', '任务已取消', { cause: cancelCause ?? 'user' })
    this.finish(execution, 'cancelled')
    return { accepted: true }
  }

  status(runId: string) {
    const snapshot = this.executions.get(runId)?.snapshot
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  async health() {
    return {
      status: 'healthy' as const,
      runtimeId,
      activeExecutions: [...this.executions.values()].filter(item => !item.terminal).length,
      acceptingRuns: true,
      dshRepository: '/tmp',
      transport: 'acp-stdio' as const,
      message: '测试 Runtime 正在接收任务',
    }
  }

  async close() {
    for (const execution of this.executions.values()) {
      if (!execution.terminal) this.finish(execution, 'cancelled')
    }
  }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string, safeMetadata: Record<string, unknown>) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: safeMetadata,
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    for (const listener of execution.listeners) listener(structuredClone(event))
  }

  private finish(execution: Execution, status: 'completed' | 'cancelled') {
    if (execution.terminal) return
    execution.terminal = true
    execution.snapshot.status = status
    execution.snapshot.endedAt = new Date().toISOString()
    execution.resolveDone(structuredClone(execution.snapshot))
  }
}
