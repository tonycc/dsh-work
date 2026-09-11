import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { WorkspaceSessionPage, WorkspaceSessionQuery, WorkspaceSessionSummary } from '@/types/domain'
import WorkspaceSessionHistory from './WorkspaceSessionHistory.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router }))

function session(overrides: Partial<WorkspaceSessionSummary> = {}): WorkspaceSessionSummary {
  return {
    sessionId: 'session-1',
    title: '季度复盘',
    creatorId: 'u-other',
    creatorName: '林岚',
    lastActiveAt: '2026-09-10T08:00:00.000Z',
    runCount: 3,
    latestRun: { id: 'run-1', status: 'succeeded' },
    ...overrides,
  }
}

function page(items: WorkspaceSessionSummary[], nextCursor: string | null = null): WorkspaceSessionPage {
  return { items, nextCursor }
}

/**
 * 按 `scope` 返回不同分页：`mine`（默认）为本人历史，`team` 为一次性空间探测。
 */
function mockSessionPages(handler: (scope: 'mine' | 'team') => WorkspaceSessionPage) {
  vi.mocked(workbenchApi.listWorkspaceSessions).mockImplementation(
    async (_workspaceId: string, input?: WorkspaceSessionQuery) => handler(input?.scope ?? 'mine'),
  )
}

function teamProbeCalls() {
  return vi.mocked(workbenchApi.listWorkspaceSessions).mock.calls
    .filter(([, input]) => input?.scope === 'team')
}

function mountHistory(options: {
  props?: Record<string, unknown>
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(WorkspaceSessionHistory, {
    props: {
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      ...options.props,
    },
    global: { plugins: [pinia, ElementPlus] },
  })
  return wrapper
}

describe('WorkspaceSessionHistory 团队历史对话视图', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue(page([]))
  })

  it('loads the first page with scope=mine and renders one row per Session', async () => {
    mockSessionPages(() => page([
      session({ sessionId: 's-1', title: '季度复盘', latestRun: { id: 'run-1', status: 'running' } }),
      session({ sessionId: 's-2', title: '库存异常排查', creatorId: 'u-current', creatorName: '周航', latestRun: { id: 'run-2', status: 'succeeded' } }),
    ]))
    const wrapper = mountHistory()
    await flushPromises()

    // 1B 是本人历史列表：首屏显式按 mine 拉取，「我的对话／团队共享」筛选属 2A。
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { scope: 'mine', limit: 20 })
    expect(teamProbeCalls()).toHaveLength(0)
    const rows = wrapper.findAll('[data-testid="session-history-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('季度复盘')
    expect(rows[0]?.text()).toContain('林岚')
    expect(rows[1]?.text()).toContain('库存异常排查')
    expect(rows[1]?.text()).toContain('周航')

    // 状态点沿用侧栏五色点语义并带 aria-label（design §4）。
    const dots = wrapper.findAll('[data-testid="session-history-dot"]')
    expect(dots[0]?.classes()).toContain('session-history-row__dot--running')
    expect(dots[0]?.attributes('aria-label')).toBe('运行中')
    expect(dots[1]?.classes()).toContain('session-history-row__dot--succeeded')
    expect(dots[1]?.attributes('aria-label')).toBe('已完成')

    // 最新运行状态用 StatusTag 呈现。
    expect(rows[0]?.find('.status-tag').text()).toBe('执行中')
    expect(rows[1]?.find('.status-tag').text()).toBe('已完成')
  })

  it('navigates to the latest Run of the row on click', async () => {
    mockSessionPages(() => page([session({ latestRun: { id: 'run/9', status: 'failed' } })]))
    const wrapper = mountHistory()
    await flushPromises()

    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    // 服务端兼容 Run ID 链接并解析回 Session。
    expect(router.push).toHaveBeenCalledWith('/conversations/run/9')
  })

  it('falls back to the Session identity when a session has no Run yet', async () => {
    mockSessionPages(() => page([session({ sessionId: 'session-empty', latestRun: null })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-row"] .status-tag').text()).toBe('暂无运行')
    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/conversations/session-empty')
  })

  it('appends the next cursor page and shows the end marker once exhausted', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })], 'cursor-1'))
      .mockResolvedValueOnce(page([session({ sessionId: 's-2', title: '库存异常排查' })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="session-history-end"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-page-info"]').text()).toContain('还有更多')

    await wrapper.find('[data-testid="session-history-load-more"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { scope: 'mine', cursor: 'cursor-1', limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="session-history-load-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-end"]').text()).toBe('已加载全部')
  })

  it('searches by title through the server and clears the filter back to the first page', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })]))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([session({ sessionId: 's-1' })]))
    const wrapper = mountHistory()
    await flushPromises()

    const input = wrapper.find('.session-history__search input')
    await input.setValue('巡检')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { scope: 'mine', query: '巡检', limit: 20 })
    const empty = wrapper.find('[data-testid="session-history-empty-filter"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('没有找到标题包含“巡检”的对话')

    await empty.find('button').trigger('click')
    await flushPromises()
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { scope: 'mine', limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
    // 筛选空态与清除筛选都不触发空间探测。
    expect(teamProbeCalls()).toHaveLength(0)
  })

  it('shows the workspace empty state when neither the caller nor the space has sessions', async () => {
    mockSessionPages(() => page([]))
    const wrapper = mountHistory()
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-workspace"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('本工作空间尚无对话')
    expect(wrapper.find('[data-testid="session-history-empty-own"]').exists()).toBe(false)
    // 一次轻量的 scope=team 探测确认空间也没有会话。
    expect(teamProbeCalls()).toHaveLength(1)
    expect(teamProbeCalls()[0]?.[1]).toEqual({ scope: 'team', limit: 1 })

    await empty.find('button').trigger('click')
    expect(wrapper.emitted('start-new')).toHaveLength(1)
  })

  it('distinguishes the caller empty history from a space that has sessions', async () => {
    mockSessionPages(scope => scope === 'team'
      ? page([session({ creatorId: 'u-other', creatorName: '林岚' })])
      : page([]))
    const wrapper = mountHistory({ props: { canStartConversation: false } })
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-own"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('你还没有在本工作空间发起过对话')
    expect(empty.text()).toContain('联系负责人添加可用 Agent 成员')
    // 本人无会话时不再展示别人的会话，也不落回「空间无会话」。
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="session-history-empty-workspace"]').exists()).toBe(false)
    expect(teamProbeCalls()).toHaveLength(1)
  })

  it('points startable members back to the new conversation from the own empty state', async () => {
    mockSessionPages(scope => scope === 'team' ? page([session()]) : page([]))
    const wrapper = mountHistory({ props: { canStartConversation: true } })
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-own"]')
    expect(empty.text()).toContain('你还没有在本工作空间发起过对话')
    await empty.find('button').trigger('click')
    expect(wrapper.emitted('start-new')).toHaveLength(1)
  })

  it('probes the team scope at most once and caches the result across reloads', async () => {
    mockSessionPages(scope => scope === 'team'
      ? page([session({ creatorId: 'u-other' })])
      : page([]))
    const wrapper = mountHistory()
    await flushPromises()
    expect(wrapper.find('[data-testid="session-history-empty-own"]').exists()).toBe(true)
    expect(teamProbeCalls()).toHaveLength(1)

    // 搜索为空结果走筛选空态，不重复探测。
    const input = wrapper.find('.session-history__search input')
    await input.setValue('巡检')
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(wrapper.find('[data-testid="session-history-empty-filter"]').exists()).toBe(true)
    expect(teamProbeCalls()).toHaveLength(1)

    // 清除筛选重新按 mine 加载空列表：命中探测缓存，仍只有一次 team 请求。
    await wrapper.find('[data-testid="session-history-empty-filter"] button').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="session-history-empty-own"]').exists()).toBe(true)
    expect(teamProbeCalls()).toHaveLength(1)
  })

  it.each([403, 422])('falls back to the workspace empty state when the team probe fails with %i', async (status) => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockImplementation(async (_workspaceId, input) => {
      if (input?.scope === 'team') throw new WorkbenchApiError({ code: 'forbidden' }, status, '探测失败')
      return page([])
    })
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-empty-workspace"]').exists()).toBe(true)
    // 探测失败不得让页面进入错误态。
    expect(wrapper.find('[data-testid="session-history-error"]').exists()).toBe(false)
    expect(teamProbeCalls()).toHaveLength(1)
  })

  it('never probes the team scope while the caller still has sessions to page through', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce(page([session({ creatorId: 'u-current' })], 'cursor-1'))
      .mockResolvedValueOnce(page([session({ sessionId: 's-2', creatorId: 'u-current' })]))
    const wrapper = mountHistory()
    await flushPromises()

    await wrapper.find('[data-testid="session-history-load-more"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(2)
    expect(teamProbeCalls()).toHaveLength(0)
  })

  it('renders neither the 我的对话 / 团队共享 filter nor a creator filter (2A)', async () => {
    mockSessionPages(() => page([session()]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.text()).not.toContain('团队共享')
    expect(wrapper.text()).not.toContain('我的对话')
    expect(wrapper.find('.session-history__toolbar select').exists()).toBe(false)
  })

  it('keeps a short time beside the full time so ≤520px can drop to the short format', async () => {
    mockSessionPages(() => page([session({ lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })]))
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-time"]').text().length).toBeGreaterThan(0)
    const short = wrapper.find('.session-history-row__time-short')
    expect(short.exists()).toBe(true)
    expect(short.text()).toMatch(/^(\d{2}:\d{2}|\d{2}-\d{2}|\d{4}-\d{2}-\d{2})$/)
    // 发起人字段保留在行内，由 ≤520px 的样式隐藏（design §2.2）。
    expect(wrapper.find('[data-testid="session-history-creator"]').exists()).toBe(true)
  })
})
