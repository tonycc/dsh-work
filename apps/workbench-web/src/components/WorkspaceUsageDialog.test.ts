import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceUsage, WorkspaceUsageDay, WorkspaceUsageRange } from '@/types/domain'
import WorkspaceUsageDialog from './WorkspaceUsageDialog.vue'

// 反馈提示走 mock：本文件要断言「关闭/卸载后不得再弹提示」，不能依赖真实 ElMessage。
const notifyActionFailure = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ notifyActionFailure }))

function day(overrides: Partial<WorkspaceUsageDay> = {}): WorkspaceUsageDay {
  return { day: '09-06', callCount: 2, successCount: 2, failedCount: 0, inputTokens: 1000, outputTokens: 500, ...overrides }
}

function usage(overrides: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
  return {
    workspaceId: 'ws-team',
    range: '7d',
    rangeDays: 7,
    totals: {
      callCount: 12,
      successCount: 10,
      failedCount: 2,
      estimatedCount: 3,
      inputTokens: 12345,
      outputTokens: 6789,
      totalTokens: 19134,
    },
    daily: [day()],
    ...overrides,
  }
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceUsageDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

/** 界面上不允许出现任何金额／币种字段（口径 §1）。 */
function expectNoMoney(text: string) {
  for (const forbidden of ['元', '¥', '￥', 'CNY', 'USD', '金额', '费用', '美元', '$']) {
    expect(text).not.toContain(forbidden)
  }
}

describe('WorkspaceUsageDialog 空间用量详情（design §2.10 / TW-09 / 4-T2）', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listWorkspaceUsage').mockResolvedValue(usage())
  })

  it('默认按 range=7d 请求一次，渲染合计行与每日明细', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockResolvedValue(usage({
      daily: [
        day({ day: '09-06', callCount: 2, successCount: 2, failedCount: 0, inputTokens: 1000, outputTokens: 500 }),
        day({ day: '09-07', callCount: 0, successCount: 0, failedCount: 0, inputTokens: 0, outputTokens: 0 }),
      ],
    }))
    const wrapper = mountDialog()
    await flushPromises()

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(1)
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledWith('ws-team', { range: '7d' })

    const totals = wrapper.find('[data-testid="usage-totals"]')
    expect(totals.text()).toContain('12')
    expect(totals.text()).toContain('10')
    expect(totals.text()).toContain('2')
    expect(totals.text()).toContain('12345')
    expect(totals.text()).toContain('6789')
    expect(totals.text()).toContain('19134')
    expect(totals.text()).toContain('调用次数')
    expect(totals.text()).toContain('成功')
    expect(totals.text()).toContain('失败')

    const rows = wrapper.findAll('[data-testid="usage-daily-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('09-06')
    expect(rows[0]!.text()).toContain('1000')
    expect(rows[0]!.text()).toContain('500')
    expect(rows[1]!.text()).toContain('09-07')
    expect(rows[1]!.text()).toContain('0')

    // 估算值明示（平台估算，非 DSH 上报）。
    expect(wrapper.find('[data-testid="usage-estimated"]').text()).toBe('其中 3 次为估算值')
    expectNoMoney(wrapper.find('[data-testid="usage-dialog"]').text())
  })

  it('estimatedCount 为 0 时不显示估算说明', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockResolvedValue(usage({
      totals: { callCount: 1, successCount: 1, failedCount: 0, estimatedCount: 0, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }))
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-testid="usage-estimated"]').exists()).toBe(false)
  })

  it('切换到 30 天后按 range=30d 重新请求并渲染新窗口的每日行', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(async (_id: string, input: { range?: WorkspaceUsageRange } = {}) =>
      input.range === '30d'
        ? usage({ range: '30d', rangeDays: 30, daily: [day({ day: '09-30', callCount: 7 })] })
        : usage({ range: '7d', rangeDays: 7, daily: [day({ day: '09-06', callCount: 2 })] }))
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).toContain('09-06')

    await wrapper.find('[data-testid="usage-range-30d"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenLastCalledWith('ws-team', { range: '30d' })
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).toContain('09-30')

    await wrapper.find('[data-testid="usage-range-7d"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenLastCalledWith('ws-team', { range: '7d' })
    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(3)
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).toContain('09-06')
  })

  it('切换时间窗时晚到的旧 range 响应不得覆盖当前窗口（3-T9 同一防竞态口径）', async () => {
    let resolveSeven!: (value: WorkspaceUsage) => void
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(async (_id: string, input: { range?: WorkspaceUsageRange } = {}) => {
      if (input.range === '7d') return new Promise<WorkspaceUsage>((resolve) => { resolveSeven = resolve })
      return usage({ range: '30d', rangeDays: 30, daily: [day({ day: '09-30', callCount: 7 })] })
    })
    const wrapper = mountDialog()
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="usage-range-30d"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).toContain('09-30')

    resolveSeven(usage({ range: '7d', rangeDays: 7, daily: [day({ day: '09-06', callCount: 2 })] }))
    await flushPromises()
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).toContain('09-30')
    expect(wrapper.find('[data-testid="usage-daily-row"]').text()).not.toContain('09-06')
  })

  it('加载中显示骨架，加载完成后替换为内容', async () => {
    let resolveFirst!: (value: WorkspaceUsage) => void
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(
      () => new Promise<WorkspaceUsage>((resolve) => { resolveFirst = resolve }),
    )
    const wrapper = mountDialog()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="usage-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-totals"]').exists()).toBe(false)

    resolveFirst(usage())
    await flushPromises()

    expect(wrapper.find('[data-testid="usage-skeleton"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="usage-totals"]').exists()).toBe(true)
  })

  it('加载失败显示错误态，「重试」真的重新请求并恢复列表', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage)
      .mockRejectedValueOnce(new Error('服务暂不可用'))
      .mockResolvedValueOnce(usage({ daily: [day({ day: '09-06', callCount: 4 })] }))
    const wrapper = mountDialog()
    await flushPromises()

    const error = wrapper.find('[data-testid="usage-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('用量加载失败')
    expect(wrapper.findAll('[data-testid="usage-daily-row"]')).toHaveLength(0)
    // 失败绝不能渲染成「零消耗」。
    expect(wrapper.find('[data-testid="usage-totals"]').exists()).toBe(false)

    await wrapper.find('[data-testid="usage-retry"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceUsage).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="usage-error"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="usage-daily-row"]')).toHaveLength(1)
  })

  it('全零数据渲染零值而不是错误态，daily 为空时才显示空态', async () => {
    vi.mocked(workbenchApi.listWorkspaceUsage).mockResolvedValue(usage({
      rangeDays: 7,
      totals: { callCount: 0, successCount: 0, failedCount: 0, estimatedCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      daily: Array.from({ length: 7 }, (_, index) => day({ day: `09-0${index + 1}`, callCount: 0, successCount: 0, failedCount: 0, inputTokens: 0, outputTokens: 0 })),
    }))
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.find('[data-testid="usage-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="usage-totals"]').text()).toContain('0')
    expect(wrapper.findAll('[data-testid="usage-daily-row"]')).toHaveLength(7)

    vi.mocked(workbenchApi.listWorkspaceUsage).mockResolvedValue(usage({ daily: [] }))
    const empty = mountDialog()
    await flushPromises()
    expect(empty.find('[data-testid="usage-empty"]').exists()).toBe(true)
    expect(empty.find('[data-testid="usage-error"]').exists()).toBe(false)
  })

  it('弹窗具备包含「空间用量」的可访问名称，关闭按钮有 aria-label', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    const dialog = wrapper.find('[role="dialog"]')
    // 不传 Element Plus 的 title（那会把 aria-label 写死成 '空间用量'），由 aria-labelledby
    // 指向包含「空间用量」与空间名的头部元素（3-T9 同一教训）。
    const labelledby = dialog.attributes('aria-labelledby')
    expect(labelledby).toBeTruthy()
    expect(wrapper.find(`[id="${labelledby}"]`).text()).toContain('空间用量')
    expect(dialog.attributes('aria-label')).toBeUndefined()
    expect(wrapper.find('[data-testid="usage-close"]').attributes('aria-label')).toBe('关闭空间用量')
  })

  it('时间窗切换控件都是真实按钮', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    expect(wrapper.find('[data-testid="usage-range-7d"]').element.tagName).toBe('BUTTON')
    expect(wrapper.find('[data-testid="usage-range-30d"]').element.tagName).toBe('BUTTON')
  })

  it('关闭弹窗后晚到的失败不得再弹提示，也不写错误态（评审 P2 口径）', async () => {
    let rejectRequest!: (reason: unknown) => void
    vi.mocked(workbenchApi.listWorkspaceUsage).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectRequest = reject }),
    )
    notifyActionFailure.mockClear()
    const wrapper = mountDialog()

    await wrapper.setProps({ open: false })
    rejectRequest(new Error('boom'))
    await flushPromises()

    expect(notifyActionFailure).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="usage-error"]').exists()).toBe(false)
  })
})
