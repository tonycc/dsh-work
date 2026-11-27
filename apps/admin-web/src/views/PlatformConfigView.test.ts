import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import PlatformConfigView from './PlatformConfigView.vue'
import { adminApi } from '../api/client'
import type { PlatformConfig, PlatformSetting } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function setting(key: string, label: string, overrides: Partial<PlatformSetting> = {}): PlatformSetting {
  return {
    key, storage: 'platform', savePermission: 'config', versionKey: `platform:${key}`, available: true, canEdit: true,
    group: 'disk', label, description: '', unit: 'GB', value: 10, defaultValue: 10, min: 2, max: 500,
    timing: '立即（包括正在运行的命令）', source: 'default', exact: true, revision: 0, ...overrides,
  }
}

function parameters(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  return {
    groups: [{ id: 'disk', title: '磁盘与工作区', description: '' }, { id: 'retention', title: '数据保留', description: '' }],
    settings: [
      setting('disk.min_free_gb', '磁盘最低剩余空间', {
        belowDefaultRisk: '低于默认值后，磁盘被写满的风险上升。', raiseRisk: '调高后立即生效，包括正在运行的命令。',
      }),
      setting('disk.min_free_percent', '磁盘最低剩余比例', { unit: '%', min: 0, max: 50 }),
      setting('notifications.retention_days', '站内通知保留天数', {
        group: 'retention', unit: '天', value: 90, defaultValue: 90, min: 30, max: 365,
        lowerRisk: '缩短后通知立即消失。', raiseRisk: '调大后更早的通知会重新出现。',
      }),
    ],
    canSave: true,
    disk: { freeBytes: 120 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 },
    overview: { entries: [], timeoutChains: [] },
    ...overrides,
  }
}

async function mountView() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  const wrapper = mount(PlatformConfigView, { attachTo: document.body, global: { plugins: [ElementPlus, router], stubs: { teleport: true } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

async function type(wrapper: VueWrapper, key: string, value: string) {
  await wrapper.get(`#parameter-${key.replace(/\./g, '\\.')}`).setValue(value)
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find(item => item.text() === label)
  if (!found) throw new Error(`没有找到按钮：${label}`)
  return found
}

describe('PlatformConfigView', () => {
  it('keeps the failure message after a rejected save and reloads the latest values (PR #178 I1)', async () => {
    const load = vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(parameters())
    vi.spyOn(adminApi, 'savePlatformSettings').mockRejectedValue(new Error('“站内通知保留天数”已被其他管理员修改，请刷新后重试'))
    const wrapper = await mountView()

    await type(wrapper, 'notifications.retention_days', '120')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    // 调大通知保留天数会让旧通知重新出现，需要先勾选已了解。
    await wrapper.get('.el-dialog input[type="checkbox"]').setValue(true)
    await button(wrapper, '确认保存').trigger('click')
    await flushPromises()

    expect(load).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('保存失败：“站内通知保留天数”已被其他管理员修改，请刷新后重试')
    expect((wrapper.get('#parameter-notifications\\.retention_days').element as HTMLInputElement).value).toBe('90')
  })

  it('asks for confirmation when raising the disk threshold and warns when it exceeds the current free space (I4)', async () => {
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(parameters())
    const save = vi.spyOn(adminApi, 'savePlatformSettings').mockResolvedValue({ settings: [] })
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('当前数据盘剩余 120 GB，共 500 GB（24%）')

    await type(wrapper, 'disk.min_free_gb', '200')
    expect(wrapper.text()).toContain('调高后立即生效，包括正在运行的命令。')
    expect(wrapper.text()).toContain('当前数据盘剩余 120 GB，低于新阈值 200 GB：保存后会立即判定为磁盘不足')
    const input = wrapper.get('#parameter-disk\\.min_free_gb')
    expect(input.attributes('aria-describedby')).toBe('parameter-warning-disk.min_free_gb')

    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    const confirm = button(wrapper, '确认保存')
    expect(confirm.attributes('disabled')).toBeDefined()
    await confirm.trigger('click')
    expect(save).not.toHaveBeenCalled()
  })

  it('treats the same number written differently as unchanged and warns about raising notification retention', async () => {
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(parameters())
    const wrapper = await mountView()
    await type(wrapper, 'disk.min_free_gb', '010')
    expect(wrapper.text()).toContain('没有未保存的修改')
    await type(wrapper, 'disk.min_free_gb', '5')
    expect(wrapper.text()).toContain('低于默认值后，磁盘被写满的风险上升。')
    await type(wrapper, 'notifications.retention_days', '200')
    expect(wrapper.text()).toContain('调大后更早的通知会重新出现。')
    expect(wrapper.text()).toContain('有 2 项未保存的修改')
  })

  it('switches tabs with the arrow keys and links each tab to its panel', async () => {
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(parameters())
    const wrapper = await mountView()
    const settingsTab = wrapper.get('#platform-config-tab-settings')
    expect(settingsTab.attributes('aria-controls')).toBe('platform-config-panel-settings')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('platform-config-tab-settings')
    await settingsTab.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('#platform-config-tab-overview').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[role="tabpanel"]').attributes('id')).toBe('platform-config-panel-overview')
  })

  it('locks safety items for a platform config administrator and still saves the rest (RP12, RP16)', async () => {
    const config = parameters()
    config.settings.push(setting('dingtalk.session_ttl_hours', '钉钉会话有效期', {
      group: 'login', storage: 'dingtalk', savePermission: 'platform-admin', versionKey: 'dingtalk', canEdit: false,
      unit: '小时', value: 12, defaultValue: 12, min: 1, max: 720, revision: 3,
    }))
    config.groups.push({ id: 'login', title: '登录与钉钉', description: '' })
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(config)
    const save = vi.spyOn(adminApi, 'savePlatformSettings').mockResolvedValue({ settings: [] })
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('标注“只有平台管理员能保存”的安全类参数不能修改。')
    expect(wrapper.text()).toContain('只有平台管理员能保存')
    expect(wrapper.get('#parameter-dingtalk\\.session_ttl_hours').attributes('disabled')).toBeDefined()
    await type(wrapper, 'disk.min_free_percent', '12')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    await button(wrapper, '确认保存').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith([{ key: 'disk.min_free_percent', value: 12, revision: 0 }])
  })

  it('tells a viewer that changes need the platform config permission', async () => {
    const config = parameters({ canSave: false })
    config.settings = config.settings.map(item => ({ ...item, canEdit: false }))
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(config)
    const wrapper = await mountView()
    expect(wrapper.text()).toContain('你可以查看平台配置；修改需要“平台配置”修改权限。')
    expect(wrapper.text()).toContain('需要“平台配置”修改权限')
  })

  it('does not prefill a value that is not a whole unit and treats any entry as a change (PR #180 I4)', async () => {
    const config = parameters()
    config.settings.push(setting('dingtalk.session_ttl_hours', '钉钉会话有效期', {
      group: 'login', storage: 'dingtalk', savePermission: 'config', versionKey: 'dingtalk',
      unit: '小时', value: 1, defaultValue: 12, min: 1, max: 720, exact: false, actual: '30 分钟', revision: 2,
    }))
    config.groups.push({ id: 'login', title: '登录与钉钉', description: '' })
    vi.spyOn(adminApi, 'getPlatformConfig').mockResolvedValue(config)
    const save = vi.spyOn(adminApi, 'savePlatformSettings').mockResolvedValue({ settings: [] })
    const wrapper = await mountView()
    const input = wrapper.get('#parameter-dingtalk\\.session_ttl_hours')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(input.attributes('placeholder')).toBe('30 分钟')
    expect(wrapper.text()).toContain('当前实际为 30 分钟，不是整小时')
    expect(wrapper.text()).toContain('没有未保存的修改')
    await type(wrapper, 'dingtalk.session_ttl_hours', '1')
    expect(wrapper.text()).toContain('有 1 项未保存的修改')
    await button(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('30 分钟 → 1 小时')
    await button(wrapper, '确认保存').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith([{ key: 'dingtalk.session_ttl_hours', value: 1, revision: 2 }])
  })
})
