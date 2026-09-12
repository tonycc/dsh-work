import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { WorkspaceInfoPanel } from '@dsh-work/workbench-components'

const teamWorkspace = {
  id: 'ws-team',
  name: '供应链团队',
  description: '团队共享的协作空间。',
  type: 'team' as const,
  memberCount: 2,
  owner: '林岚',
  members: ['林岚', '周航'],
  status: 'active' as const,
}

const personalWorkspace = {
  id: 'ws-personal',
  name: '我的空间',
  description: '个人上下文。',
  type: 'personal' as const,
  memberCount: 1,
  owner: '我',
  members: ['我'],
}

/** 摘要只接收 totals 的三个展示字段；面板自身不发任何请求（design §2.10）。 */
function summary(overrides: Partial<{ callCount: number; totalTokens: number; estimatedCount: number }> = {}) {
  return { callCount: 12, totalTokens: 19134, estimatedCount: 0, ...overrides }
}

function mountPanel(props: Record<string, unknown> = {}) {
  return mount(WorkspaceInfoPanel, {
    props: {
      workspace: teamWorkspace,
      dataScopes: ['订单数据'],
      currentUserRole: 'owner',
      canViewUsage: true,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

/** 界面上不允许出现任何金额／币种字段（口径 §1：只展示 token 与调用次数）。 */
function expectNoMoney(text: string) {
  for (const forbidden of ['元', '¥', '￥', 'CNY', 'USD', '金额', '费用', '美元', '$']) {
    expect(text).not.toContain(forbidden)
  }
}

describe('WorkspaceInfoPanel 空间用量摘要（design §2.10 / TW-09 / 4-T2）', () => {
  it('负责人可见时渲染「空间用量」摘要，估算值为 0 时不出现估算说明', () => {
    const wrapper = mountPanel({ usageSummary: summary() })

    const section = wrapper.find('[data-testid="panel-usage-section"]')
    expect(section.exists()).toBe(true)
    expect(section.text()).toContain('空间用量')
    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toBe('近 7 天 12 次调用 · 19134 tokens')
    expect(wrapper.find('[data-testid="panel-usage-estimated"]').exists()).toBe(false)
    expectNoMoney(wrapper.text())
  })

  it('仅当 estimatedCount > 0 时补一行「其中 N 次为估算值」', () => {
    const shown = mountPanel({ usageSummary: summary({ estimatedCount: 3 }) })
    expect(shown.find('[data-testid="panel-usage-estimated"]').text()).toBe('其中 3 次为估算值')

    const hidden = mountPanel({ usageSummary: summary({ estimatedCount: 0 }) })
    expect(hidden.find('[data-testid="panel-usage-estimated"]').exists()).toBe(false)
  })

  it('全零数据渲染 0，而不是错误态或空态', () => {
    const wrapper = mountPanel({
      usageSummary: summary({ callCount: 0, totalTokens: 0, estimatedCount: 0 }),
    })

    expect(wrapper.find('[data-testid="panel-usage-summary"]').text()).toBe('近 7 天 0 次调用 · 0 tokens')
    expect(wrapper.find('[data-testid="panel-usage-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-usage-skeleton"]').exists()).toBe(false)
  })

  it('加载中显示骨架，失败就地显示错误与「重试」且绝不伪装成零消耗', async () => {
    const loading = mountPanel({ usageSummary: null, usageLoading: true })
    expect(loading.find('[data-testid="panel-usage-skeleton"]').exists()).toBe(true)
    expect(loading.find('[data-testid="panel-usage-summary"]').exists()).toBe(false)

    const failed = mountPanel({ usageSummary: null, usageError: true })
    const error = failed.find('[data-testid="panel-usage-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('用量加载失败')
    // 失败不得渲染「0 次调用」这类会误导成「零消耗」的文案。
    expect(failed.text()).not.toContain('次调用')
    expect(failed.find('[data-testid="panel-usage-skeleton"]').exists()).toBe(false)

    await failed.find('[data-testid="panel-usage-retry"]').trigger('click')
    expect(failed.emitted('retry-usage')).toHaveLength(1)
  })

  it('canViewUsage 为 false（成员／只读／角色未知）时完全不渲染该区块', () => {
    for (const canViewUsage of [false, undefined]) {
      const wrapper = mountPanel({ canViewUsage, usageSummary: summary({ estimatedCount: 3 }) })
      expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('空间用量')
    }
  })

  it('个人空间即便被误传 canViewUsage 也不渲染用量区块（AC-23 纵深防御）', () => {
    const wrapper = mountPanel({ workspace: personalWorkspace, canViewUsage: true, usageSummary: summary() })

    expect(wrapper.find('[data-testid="panel-usage-section"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('空间用量')
  })

  it('「查看详情」是真实按钮并携带 MouseEvent，供宿主关闭后恢复焦点', async () => {
    const wrapper = mountPanel({ usageSummary: summary() })

    const detail = wrapper.find('[data-testid="panel-usage-view-detail"]')
    expect(detail.element.tagName).toBe('BUTTON')
    await detail.trigger('click')

    const emitted = wrapper.emitted('view-usage-detail')
    expect(emitted).toHaveLength(1)
    expect(emitted![0]![0]).toBeInstanceOf(MouseEvent)
  })

  it('用量区块不请求接口：面板本身零网络依赖（纯展示）', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      mountPanel({ usageSummary: summary() })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
