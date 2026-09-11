import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { WorkspaceSessionPage, WorkspaceSessionSummary } from '@/types/domain'
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

function mountHistory(options: {
  page?: WorkspaceSessionPage
  props?: Record<string, unknown>
  currentUserId?: string
} = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const authStore = useAuthStore(pinia)
  vi.spyOn(authStore, 'user', 'get').mockReturnValue({
    id: options.currentUserId ?? 'u-current',
    name: '周航',
    title: '计划经理',
    department: '计划部',
    avatarText: '周',
    role: 'employee',
    dataScopes: [],
  })
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
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('loads the first page without a creator filter and renders one row per Session', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [
        session({ sessionId: 's-1', title: '季度复盘', latestRun: { id: 'run-1', status: 'running' } }),
        session({ sessionId: 's-2', title: '库存异常排查', creatorId: 'u-current', creatorName: '周航', latestRun: { id: 'run-2', status: 'succeeded' } }),
      ],
      nextCursor: null,
    })
    const wrapper = mountHistory()
    await flushPromises()

    // 首版不做「我的对话／团队共享」与发起人筛选（属 2A），只按空间拉取。
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
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
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ latestRun: { id: 'run/9', status: 'failed' } })],
      nextCursor: null,
    })
    const wrapper = mountHistory()
    await flushPromises()

    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    // 服务端兼容 Run ID 链接并解析回 Session。
    expect(router.push).toHaveBeenCalledWith('/conversations/run/9')
  })

  it('falls back to the Session identity when a session has no Run yet', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ sessionId: 'session-empty', latestRun: null })],
      nextCursor: null,
    })
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-row"] .status-tag').text()).toBe('暂无运行')
    await wrapper.find('[data-testid="session-history-row"]').trigger('click')
    expect(router.push).toHaveBeenCalledWith('/conversations/session-empty')
  })

  it('appends the next cursor page and shows the end marker once exhausted', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce({ items: [session({ sessionId: 's-1' })], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [session({ sessionId: 's-2', title: '库存异常排查' })], nextCursor: null })
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="session-history-end"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-page-info"]').text()).toContain('还有更多')

    await wrapper.find('[data-testid="session-history-load-more"]').trigger('click')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-1', limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-testid="session-history-load-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="session-history-end"]').text()).toBe('已加载全部')
  })

  it('searches by title through the server and clears the filter back to the first page', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions)
      .mockResolvedValueOnce({ items: [session({ sessionId: 's-1' })], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [session({ sessionId: 's-1' })], nextCursor: null })
    const wrapper = mountHistory()
    await flushPromises()

    const input = wrapper.find('.session-history__search input')
    await input.setValue('巡检')
    await input.trigger('keyup.enter')
    await flushPromises()

    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { query: '巡检', limit: 20 })
    const empty = wrapper.find('[data-testid="session-history-empty-filter"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('没有找到标题包含“巡检”的对话')

    await empty.find('button').trigger('click')
    await flushPromises()
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenLastCalledWith('ws-team', { limit: 20 })
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
  })

  it('shows the workspace empty state with a way back to the new conversation', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({ items: [], nextCursor: null })
    const wrapper = mountHistory()
    await flushPromises()

    const empty = wrapper.find('[data-testid="session-history-empty-workspace"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('本工作空间尚无对话')
    await empty.find('button').trigger('click')
    expect(wrapper.emitted('start-new')).toHaveLength(1)
  })

  it('guides the current user who has no session of their own without hiding team sessions', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ creatorId: 'u-other' })],
      nextCursor: null,
    })
    const wrapper = mountHistory({ props: { canStartConversation: false } })
    await flushPromises()

    const hint = wrapper.find('[data-testid="session-history-own-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('你还没有在本工作空间发起过对话')
    expect(hint.text()).toContain('联系负责人添加可用 Agent 成员')
    // 首版列表展示全空间会话，提示不替换列表。
    expect(wrapper.findAll('[data-testid="session-history-row"]')).toHaveLength(1)
  })

  it('points startable members back to the new conversation instead of asking for an Agent', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ creatorId: 'u-other' })],
      nextCursor: null,
    })
    const wrapper = mountHistory({ props: { canStartConversation: true } })
    await flushPromises()

    const hint = wrapper.find('[data-testid="session-history-own-hint"]')
    expect(hint.text()).toContain('返回「新对话」即可开始第一段团队对话')
    await hint.find('button').trigger('click')
    expect(wrapper.emitted('start-new')).toHaveLength(1)
  })

  it('hides the own-session hint once the current user has a session in the loaded list', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ creatorId: 'u-current' })],
      nextCursor: null,
    })
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.find('[data-testid="session-history-own-hint"]').exists()).toBe(false)
  })

  it('renders neither the 我的对话 / 团队共享 filter nor a creator filter (2A)', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session()],
      nextCursor: null,
    })
    const wrapper = mountHistory()
    await flushPromises()

    expect(wrapper.text()).not.toContain('团队共享')
    expect(wrapper.text()).not.toContain('我的对话')
    expect(wrapper.find('.session-history__toolbar select').exists()).toBe(false)
  })

  it('keeps a short time beside the full time so ≤520px can drop to the short format', async () => {
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({
      items: [session({ lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })],
      nextCursor: null,
    })
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
