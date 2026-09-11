/**
 * 真实 DSH 端到端验证（1B 退出条件核心场景）。
 *
 * 走平台全栈 + 真实 DSH Runtime：A 上传共享文件 → 建立团队 Agent 会话 →
 * B（另一名成员）引用该不可变文件发起真实运行 → 运行完成后继续对话，
 * 并打印平台侧记录的运行事件，用于判断真实 DSH 返回里可采集哪些来源信息。
 *
 * 与集成测试的区别：本脚本使用真实 `DshAcpRuntimeAdapter`（真实模型），
 * 在一次性数据库上运行，不修改任何既有数据。
 *
 * 用法：
 *   DSH_WORK_TEST_DATABASE_URL=postgres://... node --env-file-if-exists=.env \
 *     --experimental-strip-types scripts/runtime/team-workspace-e2e.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PostgresConversationRepository } from '../../server/src/modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresContentService } from '../../server/src/modules/workbench/application/postgres-content-service.ts'
import { PostgresRunRepository } from '../../server/src/modules/run/postgres-run-repository.ts'
import { PostgresAuthorizationService } from '../../server/src/modules/authorization/postgres-authorization-service.ts'
import { PostgresAgentService } from '../../server/src/modules/agent/postgres-agent-service.ts'
import { PostgresOperationsService } from '../../server/src/modules/admin/application/postgres-operations-service.ts'
import { PostgresWorkspaceAgentMemberService } from '../../server/src/modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { ModelGovernanceService } from '../../server/src/modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../server/src/modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../server/src/modules/run/run-orchestration-service.ts'
import { DshAcpRuntimeAdapter } from '../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../../server/src/modules/runtime/dsh-runtime-installation.ts'
import { createDatabase, type DatabaseClient } from '../../server/src/infrastructure/postgres/database.ts'
import { runMigrations } from '../../server/src/infrastructure/postgres/migration-runner.ts'

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'
const marker = `TEAM-1B-${randomUUID().slice(0, 8).toUpperCase()}`
const suffix = randomUUID().slice(0, 8)
const workspaceId = `ws-e2e-${suffix}`
const ownerId = `user-e2e-owner-${suffix}`
const memberId = `user-e2e-member-${suffix}`

const maintenanceUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!maintenanceUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const databaseName = `dsh_work_e2e_${randomUUID().replaceAll('-', '')}`
const adminUrl = new URL(maintenanceUrl)
adminUrl.pathname = '/postgres'
const admin = createDatabase({ url: adminUrl.toString(), maxConnections: 2 })
await admin.unsafe(`create database "${databaseName}"`)

let database: DatabaseClient | undefined
let runtime: DshAcpRuntimeAdapter | undefined
let dataRoot: string | undefined

try {
  const testUrl = new URL(maintenanceUrl)
  testUrl.pathname = `/${databaseName}`
  database = createDatabase({ url: testUrl.toString(), maxConnections: 8 })
  await runMigrations(database)

  const projectRoot = resolve(import.meta.dirname, '../..')
  const installation = await resolveDshRuntimeInstallation({ projectRoot })
  await preflightDshRuntime(installation)
  dataRoot = await mkdtemp(join(tmpdir(), 'dsh-work-team-e2e-'))
  runtime = new DshAcpRuntimeAdapter({
    runtimeId,
    runtimeRoot: resolve(dataRoot, 'dsh-attempts'),
    dshRepository: installation.home,
    runtimeVersion: installation.version,
    runtimeCommit: installation.commit,
    protocolVersion: installation.protocolVersion,
    launchMode: installation.launchMode,
    process: installation.process,
    permissionDecision: async () => 'allow_once',
  })

  const conversations = new PostgresConversationRepository(database)
  const content = new PostgresContentService(database, resolve(dataRoot, 'storage'))
  const runs = new PostgresRunRepository(database)
  const authorization = new PostgresAuthorizationService(database)
  const agents = new PostgresAgentService(database)
  // operations 必须接线：否则 approval.resolved 触发的工具审计被静默跳过（?），
  // 而这个审计正是「工具返回数据来源」的可追溯落点（T2 关注点）。
  const operations = new PostgresOperationsService(database, runtime, authorization, 'mock')
  const orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    content,
    operations,
    agents,
    undefined,
    authorization,
  )

  // --- 合成账户与团队空间（对齐方案 §8：A=负责人、B=成员） ---
  await seedUser(ownerId, 'E2E 负责人')
  await seedUser(memberId, 'E2E 成员')
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'E2E 团队空间', '', 'team', ${ownerId}, 'active')
  `
  for (const [userId, role] of [[ownerId, 'owner'], [memberId, 'member']] as const) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${userId}, ${role}, ${ownerId})
    `
  }

  // --- A 上传共享文件（不可变对象 + 解析结果） ---
  const fileBytes = Buffer.from(`# 库存状态\n\n标记：${marker}\n\n华东仓可用 120，华北仓缺货。\n`, 'utf8')
  await content.storeWorkspaceFile(workspaceId, 'e2e-inventory.md', 'text/markdown', fileBytes, ownerId)
  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  const file = listed.items.find(item => item.name === 'e2e-inventory.md')
  if (!file) throw new Error('上传后未在共享文件列表中找到该文件')

  // --- 团队 Agent 成员关联：走真实服务（同时建立 Agent/Skill/Tool 授权来源） ---
  const agentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  await agentMembers.addAgentMember(workspaceId, 'agent-dsh-work-assistant', ownerId, ['role-employee'])

  // --- B（成员）引用该文件发起真实运行 ---
  const session = await orchestration.createSession({
    userId: memberId,
    title: '1B e2e 文件引用分析',
    workspaceId,
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const started = await orchestration.startRun({
    userId: memberId,
    sessionId: session.id,
    prompt: `请读取我提供的共享文件，并且只回复文件中的完整标记（形如 ${marker.slice(0, 4)}... 的大写串）。不要猜测。`,
    idempotencyKey: `e2e-${suffix}-1`,
    fileIds: [file.id],
  })
  if (!started) throw new Error('Run 创建失败')
  const finished = await waitForRun(runs, started.id, 240_000)

  const events = await runs.readEvents('tenant-dsh-work', started.id)
  const assistant = await conversations.getTask(started.id, memberId)

  // --- 运行完成后继续对话（1B 退出条件要求「并能继续」） ---
  const second = await orchestration.startRun({
    userId: memberId,
    sessionId: session.id,
    prompt: '再回复一次同一个标记，确认会话可以继续。',
    idempotencyKey: `e2e-${suffix}-2`,
  })
  if (!second) throw new Error('第二个 Run 创建失败')
  const secondFinished = await waitForRun(runs, second.id, 240_000)

  const secondTask = await conversations.getTask(second.id, memberId)
  const secondText = (secondTask?.messages ?? []).filter(message => message.role === 'assistant').map(message => message.content).join('')

  // --- 来源信息可采集性观察（T2 设计依据） ---
  const toolEvents = events.filter(event => event.eventType.startsWith('tool'))
  const toolMetadataKeys = [...new Set(toolEvents.flatMap(event => Object.keys(event.safeMetadata ?? {})))]
  // 审批事件的元数据 + 工具审计：确认真实 DSH 运行里「谁读了什么」落在哪里。
  const approvalEvents = events.filter(event => event.eventType.startsWith('approval'))
  if (!database) throw new Error('database 未初始化')
  const toolAuditRows = await database<{ toolVersionId: string; parameterSummary: Record<string, unknown>; result: string }[]>`
    select tool_version_id as "toolVersionId", parameter_summary as "parameterSummary", result
      from tool_audit_logs where tenant_id = ${tenantId} and run_id = ${started.id}
  `

  console.log(JSON.stringify({
    ok: finished === 'succeeded' && secondFinished === 'succeeded',
    dshVersion: installation.version,
    workspaceId,
    uploadedFileId: file.id,
    uploadedFileScanStatus: file.scanStatus,
    fileRemovable: file.removable,
    firstRun: {
      runId: started.id,
      status: finished,
      assistantTextIncludesMarker: (assistant?.messages ?? []).some(message => message.content.includes(marker)),
      eventTypes: [...new Set(events.map(event => event.eventType))],
    },
    secondRun: { runId: second.id, status: secondFinished, assistantTextIncludesMarker: secondText.includes(marker) },
    sourceInformationObserved: {
      toolEventCount: toolEvents.length,
      toolEventMetadataKeys: toolMetadataKeys,
      approvalEvents: approvalEvents.map(event => ({ type: event.eventType, metadata: event.safeMetadata })),
      toolAuditRows,
      note: '实测记录：真实 DSH 事件与工具审计里能取到哪些来源字段。原 T2「来源限制采集」已随 2A／2B 放弃，此处仅作事实留存。',
    },
  }, null, 2))
} finally {
  await runtime?.close().catch(() => undefined)
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined)
  await database?.end().catch(() => undefined)
  await admin.unsafe(`drop database if exists "${databaseName}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}

async function seedUser(id: string, displayName: string) {
  if (!database) throw new Error('database 未初始化')
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

async function waitForRun(
  runs: PostgresRunRepository,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await runs.getRun(tenantId, runId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run.status
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`等待运行结束超时：${runId}`)
}
