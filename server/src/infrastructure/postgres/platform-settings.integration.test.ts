import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { platformSettingsFromValues } from '../../domain/platform-settings.ts'
import { parseClientErrorBatch, type ErrorRecordInput } from '../../modules/observability/client-error-report.ts'
import { PostgresErrorRecordsService } from '../../modules/observability/postgres-error-records-service.ts'
import { PostgresUsageAnalyticsService } from '../../modules/observability/postgres-usage-analytics-service.ts'
import { PostgresPlatformSettingsService } from '../../modules/platform-settings/postgres-platform-settings-service.ts'
import { PostgresUserNotificationService } from '../../modules/workbench/application/postgres-user-notification-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { DingTalkSettingsService } from '../../modules/identity/dingtalk/dingtalk-settings.ts'
import type { DingTalkConfiguration } from '../../modules/identity/dingtalk/dingtalk-config.ts'

/**
 * 运行参数（RP-E2E-01、RP-E2E-03 的 PostgreSQL 部分）：保存与乐观锁、整体回滚、审计、重启后读回、
 * 以及保留期按保存值生效。保存权限由路由对照表判定，见 `admin-permissions.test.ts`。
 */
const tenantId = 'tenant-dsh-work'
const actor = 'U00008'
let throwaway: ThrowawayDatabase
let database: DatabaseClient

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_platform_settings', maxConnections: 4 })
  database = throwaway.client
})

after(async () => {
  await throwaway.dispose()
})

test('saving writes the value, bumps the revision, refreshes the snapshot and audits each change', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  await settings.load()
  assert.equal(settings.get('web_fetch.max_per_attempt'), 10)
  const before = (await settings.list()).find(item => item.key === 'web_fetch.max_per_attempt')!
  assert.deepEqual({ source: before.source, revision: before.revision }, { source: 'default', revision: 0 })

  const saved = await settings.save([
    { key: 'web_fetch.max_per_attempt', value: 1, revision: 0 },
    { key: 'automation.max_concurrent', value: 3, revision: 0 },
  ], actor)
  const webFetch = saved.find(item => item.key === 'web_fetch.max_per_attempt')!
  assert.deepEqual({ value: webFetch.value, source: webFetch.source, revision: webFetch.revision }, { value: 1, source: 'page', revision: 1 })
  assert.ok(webFetch.updatedBy)
  assert.equal(settings.get('web_fetch.max_per_attempt'), 1)
  assert.equal(settings.get('automation.max_concurrent'), 3)

  const audits = await database<{ objectId: string; context: { from: string; to: string } }[]>`
    select object_id as "objectId", safe_context as context from audit_events
     where tenant_id = ${tenantId} and action = 'platform.setting.update' and actor_id = ${actor}
     order by object_id
  `
  assert.deepEqual(audits.map(row => [row.objectId, row.context.from, row.context.to]), [
    ['automation.max_concurrent', '2', '3'],
    ['web_fetch.max_per_attempt', '10', '1'],
  ])

  // 服务重启：新实例从表中读回。
  const restarted = new PostgresPlatformSettingsService(database)
  await restarted.load()
  assert.equal(restarted.get('web_fetch.max_per_attempt'), 1)

  // 恢复默认：保留该行（值为 null），来源回到默认值，版本号继续递增；旧版本号不能再次生效（丢失更新）。
  const automation = saved.find(item => item.key === 'automation.max_concurrent')!
  const restored = (await settings.save([{ key: 'automation.max_concurrent', value: 2, revision: automation.revision }], actor))
    .find(item => item.key === 'automation.max_concurrent')!
  assert.deepEqual({ value: restored.value, source: restored.source, revision: restored.revision }, { value: 2, source: 'default', revision: 2 })
  assert.equal(settings.get('automation.max_concurrent'), 2)
  await assert.rejects(settings.save([{ key: 'automation.max_concurrent', value: 4, revision: automation.revision }], actor),
    (error: Error & { status?: number }) => error.status === 409)
  await assert.rejects(settings.save([{ key: 'automation.max_concurrent', value: 4, revision: 0 }], actor),
    (error: Error & { status?: number }) => error.status === 409)

  // 值与当前生效值相同：不写入、不递增版本号、不记审计。
  const auditCount = async () => (await database<{ count: number }[]>`
    select count(*)::integer as count from audit_events where tenant_id = ${tenantId} and action = 'platform.setting.update'
  `)[0]!.count
  const auditsBefore = await auditCount()
  const unchanged = (await settings.save([{ key: 'automation.max_concurrent', value: 2, revision: 2 }], actor))
    .find(item => item.key === 'automation.max_concurrent')!
  assert.equal(unchanged.revision, 2)
  assert.equal(await auditCount(), auditsBefore)
})

test('two first saves of the same key at once: one wins, the other gets 409 instead of a server error', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  const results = await Promise.allSettled([
    settings.save([{ key: 'workspace.failed_retention_days', value: 5, revision: 0 }], actor),
    settings.save([{ key: 'workspace.failed_retention_days', value: 6, revision: 0 }], actor),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal((rejected.reason as { status?: number }).status, 409)
})

test('a stale revision rejects the whole batch; invalid values and unknown keys are refused', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  await settings.load()
  const current = (await settings.list()).find(item => item.key === 'web_fetch.max_per_attempt')!
  await assert.rejects(settings.save([
    { key: 'disk.min_free_gb', value: 20, revision: 0 },
    { key: 'web_fetch.max_per_attempt', value: 5, revision: current.revision - 1 },
  ], actor), (error: Error & { status?: number }) => error.status === 409)
  const after = await settings.list()
  assert.equal(after.find(item => item.key === 'disk.min_free_gb')!.source, 'default')
  assert.equal(after.find(item => item.key === 'web_fetch.max_per_attempt')!.value, current.value)

  await assert.rejects(settings.save([{ key: 'error_records.retention_days', value: 30, revision: 0 }], actor), /90～365/)
  await assert.rejects(settings.save([{ key: 'session.secret', value: 1, revision: 0 }], actor), /未登记/)
  await assert.rejects(settings.save([{ key: 'disk.min_free_gb', value: 20, revision: 'x' }], actor), /版本号/)
})

test('the service rechecks the platform config permission inside the transaction (RP12, rule 13)', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  await settings.load()
  await assert.rejects(settings.save([{ key: 'disk.min_free_gb', value: 30, revision: 0 }], 'U00001'),
    (error: Error & { status?: number }) => error.status === 403 && /平台配置的修改权限/.test(error.message))
  const [row] = await database`select 1 from platform_settings where tenant_id = ${tenantId} and key = 'disk.min_free_gb'`
  assert.equal(row, undefined)
  assert.equal(settings.get('disk.min_free_gb'), 10)
})

test('the overview counts published Agents whose timeout exceeds the Runtime timeout', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  const overview = await settings.overview({ canEdit: () => true })
  assert.ok(overview.entries.some(entry => entry.id === 'runtime.runtime-local-01.timeout_minutes'))
  const conversation = overview.timeoutChains.find(chain => chain.id === 'conversation')
  assert.ok(conversation)
  assert.ok(overview.entries.find(entry => entry.id === 'web_fetch.max_per_attempt')!.canEdit)
})

test('notification and page view retention follow the saved number of days', async () => {
  const user = 'U00001'
  const workspace = `ws-personal-${user}`
  const tag = randomUUID().slice(0, 8)
  for (const daysAgo of [40, 20]) {
    await database`
      insert into user_notifications (id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id, actor_user_id,
                                      safe_metadata, dedupe_key, created_at)
      values (${`n-rp-${tag}-${daysAgo}`}, ${tenantId}, ${user}, 'workspace_member_added', ${workspace}, 'workspace', ${workspace}, ${actor},
              '{}'::jsonb, ${`rp:${tag}:${daysAgo}`}, now() - make_interval(days => ${daysAgo}))
    `
  }
  const remaining = async () => (await database<{ id: string }[]>`
    select id from user_notifications where id like ${`n-rp-${tag}-%`} order by id
  `).map(row => row.id)

  // 列表与未读数立即按保留期过滤（不等清理）。
  const shortRetention = new PostgresUserNotificationService(database, {
    settings: platformSettingsFromValues(new Map([['notifications.retention_days', 30]])),
  })
  const defaultRetention = new PostgresUserNotificationService(database)
  const listed = async (service: PostgresUserNotificationService) =>
    (await service.list({ userId: user, limit: 50 })).items.map(item => item.id).filter(id => id.startsWith(`n-rp-${tag}-`)).sort()
  assert.deepEqual(await listed(defaultRetention), [`n-rp-${tag}-20`, `n-rp-${tag}-40`])
  assert.deepEqual(await listed(shortRetention), [`n-rp-${tag}-20`])
  assert.equal((await shortRetention.list({ userId: user, limit: 1 })).retentionDays, 30)
  assert.equal((await defaultRetention.unreadCount(user)).unread - (await shortRetention.unreadCount(user)).unread, 1)

  await new PostgresUserNotificationService(database).purgeExpired()
  assert.deepEqual(await remaining(), [`n-rp-${tag}-20`, `n-rp-${tag}-40`])
  await new PostgresUserNotificationService(database, {
    settings: platformSettingsFromValues(new Map([['notifications.retention_days', 30]])),
  }).purgeExpired()
  assert.deepEqual(await remaining(), [`n-rp-${tag}-20`])

  await database`
    insert into product_events (tenant_id, user_id, app, page, occurred_at)
    values (${tenantId}, ${user}, 'workbench', ${`rp-${tag}`}, now() - interval '120 days')
  `
  const pageViews = async () => (await database<{ count: number }[]>`
    select count(*)::integer as count from product_events where page = ${`rp-${tag}`}
  `)[0]!.count
  await new PostgresUsageAnalyticsService(database, 'Asia/Shanghai').purgeExpired()
  assert.equal(await pageViews(), 1)
  await new PostgresUsageAnalyticsService(database, 'Asia/Shanghai', {
    settings: platformSettingsFromValues(new Map([['page_views.retention_days', 90]])),
  }).purgeExpired()
  assert.equal(await pageViews(), 0)

  // 错误记录：120 天前的样本在保留 365 天时保留，按默认 90 天清理。
  const { reports: [report] } = parseClientErrorBatch({ app: 'workbench', reports: [{
    kind: 'render', message: `rp retention ${tag}`, stack: '    at render (https://w/assets/index-aaaaaaaa.js:1:5)', route: 'conversation', release: '2026.11.26-01',
  }] })
  const input = { ...report!, source: 'workbench', client: 'Chrome 131 / macOS', userId: user } as ErrorRecordInput
  await new PostgresErrorRecordsService(database).record(input)
  const inGroup = database`group_id in (select id from error_groups where tenant_id = ${tenantId} and message like ${`%${tag}%`})`
  await database`update error_occurrences set occurred_at = now() - interval '120 days' where tenant_id = ${tenantId} and ${inGroup}`
  const occurrences = async () => (await database<{ count: number }[]>`
    select count(*)::integer as count from error_occurrences where tenant_id = ${tenantId} and ${inGroup}
  `)[0]!.count
  assert.equal(await occurrences(), 1)
  await new PostgresErrorRecordsService(database, {
    settings: platformSettingsFromValues(new Map([['error_records.retention_days', 365]])),
  }).purgeExpired()
  assert.equal(await occurrences(), 1)
  await new PostgresErrorRecordsService(database).purgeExpired()
  assert.equal(await occurrences(), 0)
})

async function adminWith(permission: string) {
  const roleId = `role-config-${randomUUID().slice(0, 8)}`
  const userId = `user-config-${randomUUID().slice(0, 8)}`
  await database`insert into roles (id, tenant_id, code, name, permissions) values (${roleId}, ${tenantId}, ${roleId.replaceAll('-', '_')}, ${roleId}, ${database.json([permission])})`
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status, identity_provider, business_user)
    values (${userId}, ${tenantId}, ${`directory:${userId}`}, '平台配置管理员', 'active', 'local', true)
  `
  await database`insert into user_roles (tenant_id, user_id, role_id, source_key) values (${tenantId}, ${userId}, ${roleId}, 'local')`
  return userId
}

const configAdmin = () => adminWith('admin:config:write')

test('a platform config administrator saves ordinary items but not the safety items (RP12, RP16)', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  const actorId = await configAdmin()
  const before = (await settings.list()).find(item => item.key === 'page_views.retention_days')!
  const saved = (await settings.save([{ key: 'page_views.retention_days', value: 200, revision: before.revision }], actorId))
    .find(item => item.key === 'page_views.retention_days')!
  assert.equal(saved.value, 200)
  const dingtalk = (await settings.list()).find(item => item.key === 'dingtalk.admin_daily_bind_limit')!
  assert.equal(dingtalk.savePermission, 'platform-admin')
  await assert.rejects(settings.save([
    { key: 'page_views.retention_days', value: 300, revision: saved.revision },
    { key: 'dingtalk.admin_daily_bind_limit', value: 9999, revision: dingtalk.revision },
  ], actorId), (error: Error & { status?: number }) => error.status === 403)
  assert.equal((await settings.list()).find(item => item.key === 'page_views.retention_days')!.value, 200, 'nothing in the batch was written')
})

test('Runtime capacity and timeout are saved together on runtimes.capacity and a new configuration revision (6.6.2)', async () => {
  const runtimeId = 'runtime-local-01'
  const operations = new PostgresOperationsService(database)
  await database`
    insert into runtime_configurations (tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, disabled_tools, disabled_builtin_skills, updated_by)
    select ${tenantId}, ${runtimeId}, coalesce(max(revision), 0) + 1, 2, 300, '{"network":"deny"}'::jsonb, ${database.json(['web_search'])}, '[]'::jsonb, ${actor}
      from runtime_configurations where tenant_id = ${tenantId} and runtime_id = ${runtimeId}
  `
  const settings = new PostgresPlatformSettingsService(database)
  const current = (await settings.list()).filter(item => item.versionKey === `runtime:${runtimeId}`)
  assert.equal(current.length, 2)
  const revision = current[0]!.revision
  await settings.save([
    { key: `runtime.${runtimeId}.capacity`, value: 3, revision },
    { key: `runtime.${runtimeId}.timeout_minutes`, value: 7, revision },
  ], actor)
  const [runtime] = await database<{ capacity: number; schedulingStatus: string }[]>`select capacity, scheduling_status as "schedulingStatus" from runtimes where id = ${runtimeId}`
  const [configuration] = await database<{ revision: number; concurrency: number; timeout: number; tools: string[] }[]>`
    select revision, concurrency_limit as concurrency, timeout_seconds as timeout, disabled_tools as tools
      from runtime_configurations where runtime_id = ${runtimeId} order by revision desc limit 1
  `
  assert.equal(runtime!.capacity, 3)
  assert.deepEqual({ revision: configuration!.revision, concurrency: configuration!.concurrency, timeout: configuration!.timeout, tools: configuration!.tools },
    { revision: revision + 1, concurrency: 3, timeout: 420, tools: ['web_search'] })
  await assert.rejects(settings.save([{ key: `runtime.${runtimeId}.capacity`, value: 4, revision }], actor),
    (error: Error & { status?: number }) => error.status === 409)
  await assert.rejects(settings.save([{ key: `runtime.${runtimeId}.capacity`, value: 4, revision: revision + 1 }, { key: `runtime.${runtimeId}.timeout_minutes`, value: 8, revision }], actor),
    /版本号不一致/)
  // Runtimes 页与管理助手的运行操作不再修改容量与超时（RP11）。
  await assert.rejects(operations.updateRuntimeConfiguration({ runtimeId, maxConcurrentWorkers: 5, schedulingStatus: 'accepting', actor }),
    /平台配置/)
})

test('DingTalk parameters: page saves survive restarts, credential saves keep them, and the four fields are refused there', async () => {
  const bootstrap = (overrides: Partial<DingTalkConfiguration> = {}): DingTalkConfiguration => ({
    corpId: 'ding-corp', agentId: '1001', appKey: 'ding-key', appSecret: 'ding-secret-0001', apiBaseUrl: 'https://oapi.dingtalk.com',
    timeoutMs: 10_000, sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, ...overrides,
  })
  const directoryFactory = () => ({ checkCredentials: async () => undefined }) as never
  let invalidated = 0
  const dingtalk = new DingTalkSettingsService(database, { deployment: { apiBaseUrl: 'https://oapi.dingtalk.com', bootstrap: bootstrap() }, directoryFactory })
  await dingtalk.ensureBootstrap()
  const settings = new PostgresPlatformSettingsService(database, { onDingTalkChanged: () => { invalidated += 1 } })
  // 安全类参数只认业务员工中的平台管理员（与钉钉应用配置一致，requirePlatformAdminOnly）。
  const platformAdmin = await adminWith('admin:*')
  const view = (await settings.list()).find(item => item.key === 'dingtalk.timeout_seconds')!
  assert.deepEqual({ value: view.value, available: view.available }, { value: 10, available: true })
  await settings.save([
    { key: 'dingtalk.timeout_seconds', value: 20, revision: view.revision },
    { key: 'dingtalk.session_ttl_hours', value: 6, revision: view.revision },
  ], platformAdmin)
  assert.equal(invalidated, 1)
  const row = async () => (await database<{ timeoutMs: number; sessionTtlSeconds: number; adminDailyBindLimit: number; revision: number }[]>`
    select timeout_ms as "timeoutMs", session_ttl_seconds as "sessionTtlSeconds", admin_daily_bind_limit as "adminDailyBindLimit", parameters_revision as revision
      from dingtalk_app_configurations where tenant_id = ${tenantId}
  `)[0]!
  assert.deepEqual(await row(), { timeoutMs: 20_000, sessionTtlSeconds: 21_600, adminDailyBindLimit: 50, revision: view.revision + 1 })

  // 重启：部署配置的数值不再覆盖页面保存的值。
  const restarted = new DingTalkSettingsService(database, { deployment: { apiBaseUrl: 'https://oapi.dingtalk.com', bootstrap: bootstrap({ timeoutMs: 5_000, adminDailyBindLimit: 7 }) }, directoryFactory })
  await restarted.ensureBootstrap()
  assert.deepEqual((await row()).timeoutMs, 20_000)
  assert.equal((await row()).adminDailyBindLimit, 50)

  // 钉钉集成页保存凭据：带四项被拒；不带时沿用现值。
  await assert.rejects(restarted.save({ corpId: 'ding-corp', agentId: '1001', appKey: 'ding-key', timeoutMs: 9_000 }, platformAdmin), /平台配置/)
  await restarted.save({ corpId: 'ding-corp', agentId: '1002', appKey: 'ding-key' }, platformAdmin)
  assert.equal((await row()).timeoutMs, 20_000)
  assert.equal((await row()).sessionTtlSeconds, 21_600)
})

test('concurrent Runtime saves: one wins, the other gets 409, never a server error (PR #180 I2)', async () => {
  const runtimeId = 'runtime-local-01'
  const settings = new PostgresPlatformSettingsService(database)
  for (let round = 0; round < 8; round += 1) {
    const revision = (await settings.list()).find(item => item.key === `runtime.${runtimeId}.capacity`)!.revision
    const results = await Promise.allSettled([
      // 每轮用新值：值不变的保存不写入、不推进版本，两个请求都会成功。
      settings.save([{ key: `runtime.${runtimeId}.capacity`, value: 20 + round, revision }], actor),
      settings.save([{ key: `runtime.${runtimeId}.timeout_minutes`, value: 10 + round, revision }], actor),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, `round ${round}`)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    assert.equal((rejected.reason as { status?: number }).status, 409, `round ${round}: ${String(rejected.reason)}`)
  }
})

test('a Runtime that is offline and draining can still be resized; built-in Skill and tool lists are kept (6.6.2)', async () => {
  const runtimeId = 'runtime-local-01'
  await database`update runtimes set health_status = 'offline', scheduling_status = 'draining' where id = ${runtimeId}`
  await database`
    insert into runtime_configurations (tenant_id, runtime_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, disabled_tools, disabled_builtin_skills, updated_by)
    select ${tenantId}, ${runtimeId}, max(revision) + 1, 2, 300, '{"network":"deny"}'::jsonb, ${database.json(['bash'])}, ${database.json(['dsh-work-html-page'])}, ${actor}
      from runtime_configurations where tenant_id = ${tenantId} and runtime_id = ${runtimeId}
  `
  const settings = new PostgresPlatformSettingsService(database)
  const revision = (await settings.list()).find(item => item.key === `runtime.${runtimeId}.capacity`)!.revision
  await settings.save([{ key: `runtime.${runtimeId}.capacity`, value: 7, revision }], actor)
  const [runtime] = await database<{ capacity: number; status: string }[]>`select capacity, scheduling_status as status from runtimes where id = ${runtimeId}`
  const [latest] = await database<{ tools: string[]; skills: string[]; timeout: number }[]>`
    select disabled_tools as tools, disabled_builtin_skills as skills, timeout_seconds as timeout
      from runtime_configurations where runtime_id = ${runtimeId} order by revision desc limit 1
  `
  assert.deepEqual({ capacity: runtime!.capacity, status: runtime!.status }, { capacity: 7, status: 'draining' })
  assert.deepEqual({ tools: latest!.tools, skills: latest!.skills, timeout: latest!.timeout }, { tools: ['bash'], skills: ['dsh-work-html-page'], timeout: 300 })
  const view = (await settings.list()).find(item => item.key === `runtime.${runtimeId}.capacity`)!
  assert.ok(view.updatedBy && view.updatedAt, 'the modifier is shown for Runtime rows')
  await database`update runtimes set health_status = 'healthy', scheduling_status = 'accepting' where id = ${runtimeId}`
})

test('a failure in one storage rolls back the whole batch (6.6.2)', async () => {
  const runtimeId = 'runtime-local-01'
  const settings = new PostgresPlatformSettingsService(database)
  const views = await settings.list()
  const webFetch = views.find(item => item.key === 'web_fetch.max_per_attempt')!
  const capacity = views.find(item => item.key === `runtime.${runtimeId}.capacity`)!
  await assert.rejects(settings.save([
    { key: 'web_fetch.max_per_attempt', value: webFetch.value === 7 ? 8 : 7, revision: webFetch.revision },
    { key: `runtime.${runtimeId}.capacity`, value: 9, revision: capacity.revision - 1 },
  ], actor), (error: Error & { status?: number }) => error.status === 409)
  const after = await settings.list()
  assert.equal(after.find(item => item.key === 'web_fetch.max_per_attempt')!.revision, webFetch.revision, 'the platform setting was not written')
  assert.equal(after.find(item => item.key === `runtime.${runtimeId}.capacity`)!.value, capacity.value)
})

test('DingTalk: a credential save racing a platform config save keeps the new parameters; values that are not whole units are shown exactly (PR #180 I1, I4)', async () => {
  await database`delete from dingtalk_app_configurations`
  const platformAdmin = await adminWith('admin:*')
  const settings = new PostgresPlatformSettingsService(database)
  // 应用未配置：四项只读，保存被拒。
  const missing = (await settings.list()).filter(item => item.storage === 'dingtalk')
  assert.ok(missing.every(item => item.available === false && item.unavailableReason))
  await assert.rejects(settings.save([{ key: 'dingtalk.timeout_seconds', value: 20, revision: 0 }], platformAdmin),
    (error: Error & { status?: number }) => error.status === 409)

  const bootstrap: DingTalkConfiguration = {
    corpId: 'ding-race', agentId: '1001', appKey: 'ding-race-key', appSecret: 'ding-secret-race', apiBaseUrl: 'https://oapi.dingtalk.com',
    timeoutMs: 10_000, sessionTtlSeconds: 1_800, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50,
  }
  let releaseCheck: () => void = () => undefined
  let checking: () => void = () => undefined
  const checkStarted = new Promise<void>(resolve => { checking = resolve })
  const directoryFactory = () => ({ checkCredentials: async () => { checking(); await new Promise<void>(resolve => { releaseCheck = resolve }) } }) as never
  const dingtalk = new DingTalkSettingsService(database, { deployment: { apiBaseUrl: 'https://oapi.dingtalk.com', bootstrap }, directoryFactory })
  await dingtalk.ensureBootstrap()

  const session = (await settings.list()).find(item => item.key === 'dingtalk.session_ttl_hours')!
  assert.deepEqual({ value: session.value, exact: session.exact, actual: session.actual, source: session.source }, { value: 1, exact: false, actual: '30 分钟', source: 'env' })

  const credentialSave = dingtalk.save({ corpId: 'ding-race', agentId: '1002', appKey: 'ding-race-key' }, platformAdmin)
  await checkStarted
  await settings.save([{ key: 'dingtalk.admin_daily_bind_limit', value: 3, revision: session.revision }], platformAdmin)
  releaseCheck()
  await credentialSave
  const [row] = await database<{ limit: number; revision: number; session: number }[]>`
    select admin_daily_bind_limit as limit, parameters_revision as revision, session_ttl_seconds as session from dingtalk_app_configurations
  `
  assert.deepEqual({ limit: row!.limit, revision: row!.revision, session: row!.session }, { limit: 3, revision: session.revision + 1, session: 1_800 })
})

test('session lifetime: the environment value is the initial value until the page saves one; restoring the default means 8 hours (RP-S3)', async () => {
  const admin = await adminWith('admin:*')
  const view = async (settings: PostgresPlatformSettingsService) => (await settings.list()).find(item => item.key === 'session.ttl_hours')!

  // 环境变量是整小时：显示为“环境变量”，填同一个值视为无变化，不写行、不记审计。
  const exact = new PostgresPlatformSettingsService(database, { sessionTtlSecondsFromEnvironment: 12 * 3600 })
  await exact.load()
  assert.equal(exact.sessionTtlSeconds(), 12 * 3600)
  assert.deepEqual(await view(exact).then(item => ({ value: item.value, source: item.source, exact: item.exact, revision: item.revision })),
    { value: 12, source: 'env', exact: true, revision: 0 })
  await exact.save([{ key: 'session.ttl_hours', value: 12, revision: 0 }], admin)
  const [none] = await database`select 1 from platform_settings where tenant_id = ${tenantId} and key = 'session.ttl_hours'`
  assert.equal(none, undefined)

  // 环境变量不是整小时：显示真实值，任何输入都算修改（含与取整后相同的 2 小时）。
  const inexact = new PostgresPlatformSettingsService(database, { sessionTtlSecondsFromEnvironment: 5400 })
  await inexact.load()
  assert.equal(inexact.sessionTtlSeconds(), 5400)
  const initial = await view(inexact)
  assert.deepEqual({ value: initial.value, exact: initial.exact, actual: initial.actual, source: initial.source }, { value: 2, exact: false, actual: '1 小时 30 分钟', source: 'env' })
  const saved = (await inexact.save([{ key: 'session.ttl_hours', value: 2, revision: 0 }], admin)).find(item => item.key === 'session.ttl_hours')!
  assert.deepEqual({ value: saved.value, source: saved.source, revision: saved.revision }, { value: 2, source: 'page', revision: 1 })
  assert.equal(inexact.sessionTtlSeconds(), 7200)
  const [audit] = await database<{ context: { from: string; to: string } }[]>`
    select safe_context as context from audit_events where tenant_id = ${tenantId} and action = 'platform.setting.update' and object_id = 'session.ttl_hours'
  `
  assert.deepEqual([audit!.context.from, audit!.context.to], ['5400 秒（环境变量）', '2'])

  // 页面保存后重启仍以页面为准；恢复默认为 8 小时，不回到环境变量。
  const restarted = new PostgresPlatformSettingsService(database, { sessionTtlSecondsFromEnvironment: 5400 })
  await restarted.load()
  assert.equal(restarted.sessionTtlSeconds(), 7200)
  const restored = (await restarted.save([{ key: 'session.ttl_hours', value: 8, revision: 1 }], admin)).find(item => item.key === 'session.ttl_hours')!
  assert.deepEqual({ value: restored.value, source: restored.source, revision: restored.revision }, { value: 8, source: 'default', revision: 2 })
  assert.equal(restarted.sessionTtlSeconds(), 8 * 3600)

  // 安全类参数：只有“平台配置”修改权限的管理员不能保存。
  await assert.rejects(restarted.save([{ key: 'session.ttl_hours', value: 24, revision: 2 }], await configAdmin()),
    (error: Error & { status?: number }) => error.status === 403)

  // 环境变量越界时收进 1～168 小时。
  const clamped = new PostgresPlatformSettingsService(database, { sessionTtlSecondsFromEnvironment: 60 })
  await database`delete from platform_settings where tenant_id = ${tenantId} and key = 'session.ttl_hours'`
  await clamped.load()
  assert.equal(clamped.sessionTtlSeconds(), 3600)
})

test('knowledge and model timeouts are read from the snapshot after each save (RP-S3)', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  await settings.load()
  assert.deepEqual(['knowledge.search_timeout_seconds', 'knowledge.upload_timeout_seconds', 'model.headers_timeout_seconds'].map(key => settings.get(key as never)), [10, 120, 120])
  const actorId = await configAdmin()
  await settings.save([
    { key: 'knowledge.search_timeout_seconds', value: 5, revision: 0 },
    { key: 'model.headers_timeout_seconds', value: 60, revision: 0 },
  ], actorId)
  assert.equal(settings.get('knowledge.search_timeout_seconds'), 5)
  assert.equal(settings.get('model.headers_timeout_seconds'), 60)
  const chains = new Map((await settings.overview({ canEdit: () => true })).timeoutChains.map(chain => [chain.id, chain]))
  assert.equal(chains.get('knowledge')!.actual, '10 秒')
  assert.equal(chains.get('model')!.actual, '1 分钟')
  await settings.save([
    { key: 'knowledge.search_timeout_seconds', value: 10, revision: 1 },
    { key: 'model.headers_timeout_seconds', value: 120, revision: 1 },
  ], actorId)
})

test('the overview counts enabled automations whose effective timeout exceeds the Runtime timeout (RP-S3, PR #181 N1)', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  const [version] = await database<{ id: string; timeoutSeconds: number }[]>`
    select id, timeout_seconds as "timeoutSeconds" from agent_versions where tenant_id = ${tenantId} order by timeout_seconds desc, id limit 1
  `
  assert.ok(version, 'seed has an Agent version')
  const [runtime] = await settings.runtimeLimits()
  assert.ok(runtime, 'seed has an accepting Runtime')
  // 发布版本不可修改：把主 Runtime 超时临时调到 1 分钟（短于任何 Agent 超时），用例结束后恢复。
  const key = `runtime.${runtime.id}.timeout_minutes`
  const admin = await adminWith('admin:*')
  const timeoutView = (await settings.list()).find(item => item.key === key)!
  const saved = (await settings.save([{ key, value: 1, revision: timeoutView.revision }], admin)).find(item => item.key === key)!
  const runtimeSeconds = 60
  assert.ok(version.timeoutSeconds > runtimeSeconds)
  const below = runtimeSeconds - 1
  const insert = async (status: string, template: unknown) => {
    const id = `automation-rp-${randomUUID().slice(0, 8)}`
    await database`
      insert into agent_automations (id, tenant_id, owner_user_id, name, agent_version_id, workspace_id, schedule, input_template, status)
      values (${id}, ${tenantId}, 'U00001', ${id}, ${version.id}, 'ws-personal-U00001', ${database.json({ kind: 'manual', timezone: 'Asia/Shanghai' })},
              ${database.json(template as never)}, ${status})
    `
    return id
  }
  const ids = [
    // 预算很大：实际按 Agent 超时；没有预算：同样按 Agent 超时；预算很小：不会被 Runtime 截断；草稿不计。
    await insert('enabled', { prompt: 'a', budget: { timeoutSeconds: 100_000 } }),
    await insert('enabled', { prompt: 'b' }),
    await insert('enabled', { prompt: 'c', budget: { timeoutSeconds: below } }),
    await insert('draft', { prompt: 'd', budget: { timeoutSeconds: 100_000 } }),
  ]
  try {
    const chains = (await settings.overview({ canEdit: () => true })).timeoutChains
    const automation = chains.find(chain => chain.id === 'automation')!
    assert.match(automation.warning ?? '', /^2 个已启用任务的运行超时大于/)
    assert.ok(chains.some(chain => chain.id === 'release-trial'))
  } finally {
    await database`delete from agent_automations where tenant_id = ${tenantId} and id = any(${ids})`
    await settings.save([{ key, value: timeoutView.value, revision: saved.revision }], admin)
  }
})
