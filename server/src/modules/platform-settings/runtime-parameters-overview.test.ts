import assert from 'node:assert/strict'
import test from 'node:test'

import { PLATFORM_SETTING_DEFINITIONS, platformSettingView, type PlatformSettingView } from '../../domain/platform-settings.ts'
import { dingtalkViews } from './postgres-platform-settings-service.ts'
import { buildRuntimeParametersOverview, formatDuration, type RuntimeParametersOverviewInput } from './runtime-parameters-overview.ts'

function settings(overrides: Record<string, number> = {}): PlatformSettingView[] {
  const platform = PLATFORM_SETTING_DEFINITIONS.map(definition => platformSettingView(definition,
    definition.key in overrides ? { value: overrides[definition.key], revision: 1 } : undefined))
  const dingtalk = dingtalkViews({ status: 'configured', source: 'admin', sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10_000, revision: 2 })
  return [...platform, ...dingtalk]
}

function input(overrides: Partial<RuntimeParametersOverviewInput> = {}): RuntimeParametersOverviewInput {
  return {
    settings: settings({ 'web_fetch.max_per_attempt': 3 }),
    runtimes: [{ id: 'runtime-local-01', name: 'runtime-local-01', capacity: 4, timeoutSeconds: 180, configured: true, agentsOverTimeout: 2 }],
    sessionTtl: { seconds: 28_800, fromEnvironment: false },
    canEdit: owner => owner.kind === 'module' && owner.module === 'config',
    ...overrides,
  }
}

test('durations read as hours, minutes or seconds', () => {
  assert.equal(formatDuration(28_800), '8 小时')
  assert.equal(formatDuration(180), '3 分钟')
  assert.equal(formatDuration(25), '25 秒')
  assert.equal(formatDuration(90), '90 秒')
})

test('settings link to the platform config page; safety items need the platform administrator (RP12, RP16)', () => {
  const overview = buildRuntimeParametersOverview(input())
  const webFetch = overview.entries.find(entry => entry.id === 'web_fetch.max_per_attempt')!
  assert.deepEqual(
    { group: webFetch.group, value: webFetch.value, source: webFetch.source, link: webFetch.link, canEdit: webFetch.canEdit },
    { group: 'config', value: '3 次', source: 'page', link: '/platform-config', canEdit: true },
  )
  assert.equal(overview.entries.find(entry => entry.id === 'disk.min_free_percent')!.value, '10%')
  const dailyLimit = overview.entries.find(entry => entry.id === 'dingtalk.admin_daily_bind_limit')!
  assert.deepEqual({ owner: dailyLimit.owner, canEdit: dailyLimit.canEdit, value: dailyLimit.value }, { owner: { kind: 'platform-admin' }, canEdit: false, value: '50 次' })
  assert.equal(overview.entries.find(entry => entry.id === 'dingtalk.timeout_seconds')!.canEdit, true)
  const agent = overview.entries.find(entry => entry.id === 'agent.limits')!
  assert.deepEqual({ group: agent.group, owner: agent.owner }, { group: 'other', owner: { kind: 'module', module: 'agent' } })
  const fixed = overview.entries.filter(entry => entry.group === 'fixed')
  assert.ok(fixed.length > 0)
  assert.ok(fixed.every(entry => entry.owner === null && entry.canEdit === false && entry.link === undefined))
  const viewer = buildRuntimeParametersOverview(input({ canEdit: () => false }))
  assert.ok(viewer.entries.every(entry => entry.canEdit === false))
})

test('DingTalk parameters are read-only when the application is not configured', () => {
  const views = dingtalkViews({ status: 'cleared', source: 'admin', sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10_000, revision: 3 })
  assert.ok(views.every(view => view.available === false && view.unavailableReason))
  assert.deepEqual(views.map(view => view.value), [12, 5, 50, 10])
  const overview = buildRuntimeParametersOverview(input({ settings: [...settings().filter(item => item.storage !== 'dingtalk'), ...views], canEdit: () => true }))
  assert.equal(overview.entries.find(entry => entry.id === 'dingtalk.timeout_seconds')!.canEdit, false)
})

test('the session lifetime reports where its value comes from', () => {
  const session = buildRuntimeParametersOverview(input({ sessionTtl: { seconds: 3600, fromEnvironment: true } }))
    .entries.find(entry => entry.id === 'identity.session_ttl')!
  assert.deepEqual({ value: session.value, source: session.source }, { value: '1 小时', source: 'env' })
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
  assert.deepEqual({ actual: shortRuntime.get('admin-assistant')!.actual, limiter: shortRuntime.get('admin-assistant')!.limiter }, { actual: '1 分钟', limiter: 'Runtime 单次执行超时' })

  const noRuntime = buildRuntimeParametersOverview(input({ runtimes: [] })).timeoutChains.map(chain => chain.id)
  assert.deepEqual(noRuntime, ['model', 'knowledge'])
})

test('the overview never carries secrets or environment values beyond the whitelisted numbers', () => {
  const text = JSON.stringify(buildRuntimeParametersOverview(input()))
  // 凭据只出现名称（“钉钉 CorpId / AppKey / AppSecret”），不出现任何取值或环境变量。
  assert.doesNotMatch(text, /DATABASE_URL|sessionSecret|MASTER_KEY|secretHint|apiKey"|DSH_WORK_/)
})
