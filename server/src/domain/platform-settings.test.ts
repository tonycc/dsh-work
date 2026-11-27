import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLATFORM_SETTING_DEFINITIONS,
  DINGTALK_PARAMETER_DEFINITIONS,
  defaultPlatformSettings,
  diskThresholds,
  parseRuntimeSettingKey,
  runtimeSettingDefinitions,
  toPageValue,
  parsePlatformSettingChanges,
  platformSettingsFromValues,
  validatePlatformSettingValue,
} from './platform-settings.ts'

test('registry: ops parameters are stored in platform_settings and saved with the platform config permission (RP12)', () => {
  assert.equal(new Set(PLATFORM_SETTING_DEFINITIONS.map(item => item.key)).size, PLATFORM_SETTING_DEFINITIONS.length)
  for (const definition of [...PLATFORM_SETTING_DEFINITIONS, ...DINGTALK_PARAMETER_DEFINITIONS]) {
    assert.ok(definition.min <= definition.defaultValue && definition.defaultValue <= definition.max, definition.key)
  }
  assert.ok(PLATFORM_SETTING_DEFINITIONS.every(item => item.storage === 'platform'))
  // 登录会话有效期是安全类参数（RP-S3）：只有平台管理员能保存；其余由“平台配置”修改权限保存。
  assert.deepEqual(PLATFORM_SETTING_DEFINITIONS.filter(item => item.savePermission !== 'config').map(item => item.key), ['session.ttl_hours'])
})

test('reader: the session lifetime starts from the environment value until the page saves one (RP-S3)', () => {
  assert.equal(platformSettingsFromValues(new Map(), { 'session.ttl_hours': 12 }).get('session.ttl_hours'), 12)
  assert.equal(platformSettingsFromValues(new Map([['session.ttl_hours', 24]]), { 'session.ttl_hours': 12 }).get('session.ttl_hours'), 24)
  // 恢复默认（值为 null）回到 8 小时，而不是环境变量。
  assert.equal(platformSettingsFromValues(new Map([['session.ttl_hours', null]]), { 'session.ttl_hours': 12 }).get('session.ttl_hours'), 8)
  assert.equal(platformSettingsFromValues(new Map()).get('knowledge.search_timeout_seconds'), 10)
})

test('registry: DingTalk lifetimes and the daily bind limit are platform-admin only; the API timeout is config (RP16)', () => {
  const permission = Object.fromEntries(DINGTALK_PARAMETER_DEFINITIONS.map(item => [item.key, item.savePermission]))
  assert.deepEqual(permission, {
    'dingtalk.session_ttl_hours': 'platform-admin',
    'dingtalk.binding_ticket_ttl_minutes': 'platform-admin',
    'dingtalk.admin_daily_bind_limit': 'platform-admin',
    'dingtalk.timeout_seconds': 'config',
  })
})

test('runtime keys carry the Runtime ID; timeouts convert between minutes and stored seconds', () => {
  assert.deepEqual(parseRuntimeSettingKey('runtime.runtime-local-01.capacity'), { runtimeId: 'runtime-local-01', field: 'capacity' })
  assert.deepEqual(parseRuntimeSettingKey('runtime.r1.timeout_minutes'), { runtimeId: 'r1', field: 'timeout_minutes' })
  assert.equal(parseRuntimeSettingKey('runtime.r1.other'), null)
  assert.equal(parseRuntimeSettingKey('runtime..capacity'), null)
  const [capacity, timeout] = runtimeSettingDefinitions({ id: 'r1', name: '本机' })
  assert.deepEqual([capacity!.min, capacity!.max, timeout!.min, timeout!.max], [1, 128, 1, 60])
  assert.equal(toPageValue(timeout!, 300), 5)
  assert.equal(toPageValue(timeout!, 90), 2, 'seconds that are not whole minutes round up')
})

test('registry: retention lower bounds keep the 90-day views complete (RP6)', () => {
  const byKey = new Map(PLATFORM_SETTING_DEFINITIONS.map(item => [item.key, item]))
  assert.equal(byKey.get('error_records.retention_days')!.min, 90)
  assert.equal(byKey.get('page_views.retention_days')!.min, 90)
  assert.equal(byKey.get('error_records.retention_days')!.defaultValue, 90)
  assert.equal(byKey.get('page_views.retention_days')!.defaultValue, 180)
})

test('validation: only registered keys and integers within range are accepted', () => {
  assert.equal(validatePlatformSettingValue('web_fetch.max_per_attempt', 1), 1)
  assert.throws(() => validatePlatformSettingValue('web_fetch.max_per_attempt', 0), /1～50/)
  assert.throws(() => validatePlatformSettingValue('web_fetch.max_per_attempt', 2.5), /整数/)
  assert.throws(() => validatePlatformSettingValue('web_fetch.max_per_attempt', '3'), /整数/)
  assert.throws(() => validatePlatformSettingValue('session.secret', 3), /未登记/)
})

test('reader: saved values win; missing, invalid or out-of-range values fall back to the default', () => {
  const reader = platformSettingsFromValues(new Map<string, unknown>([
    ['web_fetch.max_per_attempt', 3],
    ['automation.max_concurrent', 999],
    ['notifications.retention_days', 'x'],
  ]))
  assert.equal(reader.get('web_fetch.max_per_attempt'), 3)
  assert.equal(reader.get('automation.max_concurrent'), 2)
  assert.equal(reader.get('notifications.retention_days'), 90)
  assert.equal(reader.get('page_views.retention_days'), 180)
  assert.equal(defaultPlatformSettings.get('disk.min_free_gb'), 10)
})

test('disk thresholds convert GB and percent into bytes and a ratio', () => {
  const reader = platformSettingsFromValues(new Map<string, unknown>([['disk.min_free_gb', 20], ['disk.min_free_percent', 5]]))
  assert.deepEqual(diskThresholds(reader), { minFreeBytes: 20 * 1024 ** 3, minFreeRatio: 0.05 })
  assert.deepEqual(diskThresholds(defaultPlatformSettings), { minFreeBytes: 10 * 1024 ** 3, minFreeRatio: 0.1 })
})

test('changes: a non-empty list without duplicate keys', () => {
  assert.deepEqual(parsePlatformSettingChanges({ changes: [{ key: 'disk.min_free_gb', value: 12, revision: 0 }] }),
    [{ key: 'disk.min_free_gb', value: 12, revision: 0 }])
  assert.throws(() => parsePlatformSettingChanges({ changes: [] }), /请提交/)
  assert.throws(() => parsePlatformSettingChanges({}), /请提交/)
  assert.throws(() => parsePlatformSettingChanges({ changes: [{ value: 1 }] }), /缺少键/)
  assert.throws(() => parsePlatformSettingChanges({
    changes: [{ key: 'disk.min_free_gb', value: 12, revision: 0 }, { key: 'disk.min_free_gb', value: 13, revision: 0 }],
  }), /重复/)
})
