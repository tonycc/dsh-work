import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import RuntimeParametersView from './RuntimeParametersView.vue'
import { adminApi } from '../api/client'
import type { PlatformSetting, RuntimeParameters } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function setting(key: string, label: string, overrides: Partial<PlatformSetting> = {}): PlatformSetting {
  return {
    key, group: 'disk', label, description: '', unit: 'GB', value: 10, defaultValue: 10, min: 2, max: 500,
    timing: '立即（包括正在运行的命令）', source: 'default', revision: 0, ...overrides,
  }
}

function parameters(overrides: Partial<RuntimeParameters> = {}): RuntimeParameters {
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
  const wrapper = mount(RuntimeParametersView, { attachTo: document.body, global: { plugins: [ElementPlus, router], stubs: { teleport: true } } })
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

describe('RuntimeParametersView', () => {
  it('keeps the failure message after a rejected save and reloads the latest values (PR #178 I1)', async () => {
    const load = vi.spyOn(adminApi, 'getRuntimeParameters').mockResolvedValue(parameters())
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
    vi.spyOn(adminApi, 'getRuntimeParameters').mockResolvedValue(parameters())
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
    vi.spyOn(adminApi, 'getRuntimeParameters').mockResolvedValue(parameters())
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
    vi.spyOn(adminApi, 'getRuntimeParameters').mockResolvedValue(parameters())
    const wrapper = await mountView()
    const settingsTab = wrapper.get('#runtime-parameters-tab-settings')
    expect(settingsTab.attributes('aria-controls')).toBe('runtime-parameters-panel-settings')
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('runtime-parameters-tab-settings')
    await settingsTab.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('#runtime-parameters-tab-overview').attributes('aria-selected')).toBe('true')
    expect(wrapper.get('[role="tabpanel"]').attributes('id')).toBe('runtime-parameters-panel-overview')
  })
})
