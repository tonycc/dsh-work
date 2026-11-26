import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { platformSettingsFromValues } from '../../domain/platform-settings.ts'
import { PostgresUsageAnalyticsService } from '../../modules/observability/postgres-usage-analytics-service.ts'
import { PostgresPlatformSettingsService } from '../../modules/platform-settings/postgres-platform-settings-service.ts'
import { PostgresUserNotificationService } from '../../modules/workbench/application/postgres-user-notification-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

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

  // 恢复默认：删除保存的值，来源回到默认值，并记审计。
  const automation = saved.find(item => item.key === 'automation.max_concurrent')!
  const restored = (await settings.save([{ key: 'automation.max_concurrent', value: 2, revision: automation.revision }], actor))
    .find(item => item.key === 'automation.max_concurrent')!
  assert.deepEqual({ value: restored.value, source: restored.source, revision: restored.revision }, { value: 2, source: 'default', revision: 0 })
  assert.equal(settings.get('automation.max_concurrent'), 2)
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

test('the overview counts published Agents whose timeout exceeds the Runtime timeout', async () => {
  const settings = new PostgresPlatformSettingsService(database)
  const overview = await settings.overview({ sessionTtl: { seconds: 28_800, fromEnvironment: false }, canEdit: () => true })
  assert.ok(overview.entries.some(entry => entry.id === 'runtime.runtime-local-01.timeout'))
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
})
