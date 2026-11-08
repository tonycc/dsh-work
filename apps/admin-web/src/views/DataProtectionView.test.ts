import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuthStore } from '@/stores/auth'
import DataProtectionView from './DataProtectionView.vue'
import { parseTermsCsv } from './data-protection-csv'

const api = vi.hoisted(() => ({
  getDataProtectionOverview: vi.fn(),
  getDataProtectionRecords: vi.fn(),
  getDataProtectionTerms: vi.fn(),
  getDataProtectionAllowlist: vi.fn(),
  getModelProviders: vi.fn(),
  addDataProtectionTerms: vi.fn(),
  previewDataProtection: vi.fn(),
}))
vi.mock('@/api/client', () => ({ adminApi: api }))

const elStubs = { ElTable: { template: '<div><slot /></div>' }, ElTableColumn: true, ElSelect: true, ElOption: true }

async function render(hasTerms: boolean) {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  Object.defineProperty(auth, 'canAccessDataProtectionTerms', { value: hasTerms })
  Object.defineProperty(auth, 'canManage', { value: true })
  const wrapper = mount(DataProtectionView, { global: { plugins: [ElementPlus], stubs: elStubs } })
  await flushPromises()
  return wrapper
}

async function openTab(wrapper: Awaited<ReturnType<typeof render>>, name: string) {
  ;(wrapper.vm as unknown as { activeTab: string; onTabChange(name: string): void }).activeTab = name
  ;(wrapper.vm as unknown as { onTabChange(name: string): void }).onTabChange(name)
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getDataProtectionOverview.mockResolvedValue({ externalRequests: 10, maskedRequests: 2, blockedMessages: 1, imageRequests: 0, secret: 1, personal: 2, term: 3 })
  api.getDataProtectionRecords.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
  api.getDataProtectionTerms.mockResolvedValue([])
  api.getDataProtectionAllowlist.mockResolvedValue([])
  api.getModelProviders.mockResolvedValue([])
})

describe('数据防护页', () => {
  it('打开后显示命中概况', async () => {
    const wrapper = await render(true)
    expect(wrapper.text()).toContain('外部厂商请求')
    expect(wrapper.text()).toContain('保密词表')
    expect(wrapper.text()).toContain('不保存命中的原文')
  })

  it('没有词表权限时不请求词表，显示无权限', async () => {
    const wrapper = await render(false)
    await openTab(wrapper, 'terms')
    expect(api.getDataProtectionTerms).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('没有查看权限')
    await openTab(wrapper, 'allow')
    expect(api.getDataProtectionAllowlist).not.toHaveBeenCalled()
  })

  it('有词表权限时加载词表', async () => {
    const wrapper = await render(true)
    await openTab(wrapper, 'terms')
    expect(api.getDataProtectionTerms).toHaveBeenCalledOnce()
  })
})

describe('CSV 解析', () => {
  it('跳过表头和空行，读取可选列，支持引号', () => {
    expect(parseTermsCsv('﻿词条,区分大小写,整词匹配\n华星科技\n\nFalcon,是,1\n"a,b",否\n')).toEqual([
      { value: '华星科技', caseSensitive: false, wholeWord: false },
      { value: 'Falcon', caseSensitive: true, wholeWord: true },
      { value: 'a,b', caseSensitive: false, wholeWord: false },
    ])
  })
})
