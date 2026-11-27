import assert from 'node:assert/strict'
import test from 'node:test'

import { PLATFORM_SETTING_DEFINITIONS, type PlatformSettingView } from '../../domain/platform-settings.ts'
import { buildRuntimeParametersOverview, formatDuration, type RuntimeParametersOverviewInput } from './runtime-parameters-overview.ts'

function settings(overrides: Record<string, number> = {}): PlatformSettingView[] {
  return PLATFORM_SETTING_DEFINITIONS.map(definition => ({
    key: definition.key, group: definition.group, label: definition.label, description: definition.description,
    unit: definition.unit, value: overrides[definition.key] ?? definition.defaultValue, defaultValue: definition.defaultValue,
    min: definition.min, max: definition.max, timing: definition.timing,
    source: definition.key in overrides ? 'page' : 'default', revision: definition.key in overrides ? 1 : 0,
  }))
}

function input(overrides: Partial<RuntimeParametersOverviewInput> = {}): RuntimeParametersOverviewInput {
  return {
    settings: settings({ 'web_fetch.max_per_attempt': 3 }),
    runtimes: [{ id: 'runtime-local-01', name: 'runtime-local-01', capacity: 4, timeoutSeconds: 180, configured: true, agentsOverTimeout: 2 }],
    sessionTtl: { seconds: 28_800, fromEnvironment: false },
    dingtalk: { source: 'admin', sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10_000 },
    canEdit: owner => owner.kind === 'platform-admin',
    ...overrides,
  }
}

test('durations read as hours, minutes or seconds', () => {
  assert.equal(formatDuration(28_800), '8 小时')
  assert.equal(formatDuration(180), '3 分钟')
  assert.equal(formatDuration(25), '25 秒')
  assert.equal(formatDuration(90), '90 秒')
})

test('ops settings show their value, source and the runtime parameters page; other owners follow canEdit', () => {
  const overview = buildRuntimeParametersOverview(input())
  const webFetch = overview.entries.find(entry => entry.id === 'web_fetch.max_per_attempt')!
  assert.deepEqual(
    { value: webFetch.value, source: webFetch.source, link: webFetch.link, canEdit: webFetch.canEdit },
    { value: '3 次', source: 'page', link: '/runtime-parameters', canEdit: true },
  )
  assert.equal(overview.entries.find(entry => entry.id === 'disk.min_free_percent')!.value, '10%')
  const capacity = overview.entries.find(entry => entry.id === 'runtime.runtime-local-01.capacity')!
  assert.deepEqual({ owner: capacity.owner, canEdit: capacity.canEdit }, { owner: { kind: 'module', module: 'connector' }, canEdit: false })
  const fixed = overview.entries.filter(entry => entry.group === 'fixed')
  assert.ok(fixed.length > 0)
  assert.ok(fixed.every(entry => entry.owner === null && entry.canEdit === false && entry.link === undefined))
  const viewer = buildRuntimeParametersOverview(input({ canEdit: () => false }))
  assert.ok(viewer.entries.every(entry => entry.canEdit === false))
})

test('the session lifetime and DingTalk settings report where their values come from', () => {
  const fromEnvironment = buildRuntimeParametersOverview(input({ sessionTtl: { seconds: 3600, fromEnvironment: true }, dingtalk: null }))
  const session = fromEnvironment.entries.find(entry => entry.id === 'identity.session_ttl')!
  assert.deepEqual({ value: session.value, source: session.source }, { value: '1 小时', source: 'env' })
  assert.equal(fromEnvironment.entries.some(entry => entry.id.startsWith('dingtalk.')), false)
  const dingtalk = buildRuntimeParametersOverview(input()).entries.find(entry => entry.id === 'dingtalk.session')!
  assert.deepEqual({ value: dingtalk.value, source: dingtalk.source }, { value: '12 小时 / 5 分钟', source: 'page' })
})

test('timeout chains show the effective value, the limiting layer and truncated Agents', () => {
  const chains = new Map(buildRuntimeParametersOverview(input()).timeoutChains.map(chain => [chain.id, chain]))
  assert.equal(chains.get('conversation')!.actual, '≤ 3 分钟')
  assert.match(chains.get('conversation')!.warning!, /2 个已发布 Agent 的运行超时大于 3 分钟/)
  assert.deepEqual({ actual: chains.get('admin-assistant')!.actual, limiter: chains.get('admin-assistant')!.limiter }, { actual: '3 分钟', limiter: '内置上限 180 秒' })
  assert.equal(chains.get('background')!.actual, '2 分钟')
  assert.deepEqual({ actual: chains.get('knowledge')!.actual, limiter: chains.get('knowledge')!.limiter }, { actual: '20 秒', limiter: '检索超时 × 2 个请求' })

  const shortRuntime = new Map(buildRuntimeParametersOverview(input({
    runtimes: [{ id: 'r', name: 'r', capacity: 2, timeoutSeconds: 60, configured: false, agentsOverTimeout: 0 }],
  })).timeoutChains.map(chain => [chain.id, chain]))
  assert.equal(shortRuntime.get('conversation')!.warning, undefined)
  const unconfigured = buildRuntimeParametersOverview(input({
    runtimes: [{ id: 'r', name: 'r', capacity: 2, timeoutSeconds: 300, configured: false, agentsOverTimeout: 0 }],
  })).entries.find(entry => entry.id === 'runtime.r.timeout')!
  assert.equal(unconfigured.source, 'default', 'a Runtime never configured on the Runtimes page is not page-configured')
  assert.deepEqual({ actual: shortRuntime.get('admin-assistant')!.actual, limiter: shortRuntime.get('admin-assistant')!.limiter }, { actual: '1 分钟', limiter: 'Runtime 单次执行超时' })

  const noRuntime = buildRuntimeParametersOverview(input({ runtimes: [] })).timeoutChains.map(chain => chain.id)
  assert.deepEqual(noRuntime, ['model', 'knowledge'])
})

test('the overview never carries secrets or environment values beyond the whitelisted numbers', () => {
  const text = JSON.stringify(buildRuntimeParametersOverview(input()))
  assert.doesNotMatch(text, /SECRET|DATABASE_URL|corpId|appKey|sessionSecret|MASTER_KEY/i)
})
