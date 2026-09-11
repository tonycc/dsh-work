import ElementPlus, { ElDialog, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { Artifact, Workspace } from '@/types/domain'
import WorkspaceDetailView from './WorkspaceDetailView.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))
const route = vi.hoisted(() => ({ query: {} as Record<string, unknown>, params: { id: 'ws-team' } }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-team',
    name: '供应链团队',
    description: '团队共享的协作空间。',
    type: 'team',
    memberCount: 2,
    sessionCount: 1,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚', '周航'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

async function mountView(item: Workspace, options: { ownerName?: string; artifacts?: Artifact[] } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, item)
  contentStore.artifacts.splice(0, contentStore.artifacts.length, ...(options.artifacts ?? []))
  // 组件 onMounted 会 refresh；测试固定注入的空间对象。
  vi.spyOn(contentStore, 'refresh').mockResolvedValue(undefined)
  const authStore = useAuthStore(pinia)
  vi.spyOn(authStore, 'user', 'get').mockReturnValue({
    id: 'u-current',
    name: options.ownerName ?? '周航',
    title: '计划经理',
    department: '计划部',
    avatarText: '周',
    role: 'employee',
    dataScopes: ['订单数据'],
  })
  const wrapper = mount(WorkspaceDetailView, {
    global: {
      plugins: [pinia, ElementPlus],
      stubs: { ConversationStarter: true },
    },
  })
  await flushPromises()
  return { wrapper }
}

describe('WorkspaceDetailView 团队分支与个人空间红线', () => {
  beforeEach(() => {
    route.params = { id: 'ws-team' }
    route.query = {}
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: null })
    vi.spyOn(workbenchApi, 'listMemberCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceAgentCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('renders the Agent segment for a team space and loads members via the T4 API', async () => {
    const { wrapper } = await mountView(workspace())

    expect(workbenchApi.listWorkspaceAgentMembers).toHaveBeenCalledWith('ws-team')
    expect(workbenchApi.listWorkspaceMembers).toHaveBeenCalledWith('ws-team')
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
  })

  it('uses the server roster and server-resolved role instead of inferring ownership from the creator name', async () => {
    // 当前登录用户是空间创建者（owner 字段），但服务端说其角色是 member：
    // 负责人已转交给别人，创建者不得再看到写入口。
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [
        { userId: 'u-new-owner', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
        { userId: 'u-current', displayName: '林岚', role: 'member', joinedAt: '2026-09-01T00:00:00.000Z' },
      ],
      currentUserRole: 'member',
    })
    const { wrapper } = await mountView(workspace(), { ownerName: '林岚' })

    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
  })

  it('treats the server-declared owner as owner even when they are not the workspace creator', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-current', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'owner',
    })
    // 创建者是「林岚」，当前用户是转交后的新负责人「周航」。
    const { wrapper } = await mountView(workspace(), { ownerName: '周航' })

    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(true)
  })

  it('opens the team management entry only for the resolved owner', async () => {
    const { wrapper } = await mountView(workspace(), { ownerName: '林岚' })

    const entry = wrapper.find('[data-testid="panel-manage-members"]')
    expect(entry.exists()).toBe(true)
    const settingsEntry = wrapper.find('[data-testid="panel-workspace-settings"]')
    expect(settingsEntry.exists()).toBe(true)
    const dialogs = wrapper.findAllComponents(ElDialog)
    expect(dialogs.map(dialog => dialog.props('modelValue'))).toEqual([false, false])

    // 团队分支才挂载 2.6 成员管理弹窗与 2.7 空间设置弹窗。
    await entry.trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([true, false])
    expect(wrapper.find('.member-dialog__body').exists()).toBe(true)

    await settingsEntry.trigger('click')
    await flushPromises()
    expect(wrapper.findAllComponents(ElDialog).map(dialog => dialog.props('modelValue'))).toEqual([true, true])
    expect(wrapper.find('.settings-dialog__body').exists()).toBe(true)
  })

  it('renders the 新对话／历史对话 switch for a team space and defaults to the new conversation', async () => {
    const { wrapper } = await mountView(workspace())

    const viewbar = wrapper.find('[data-testid="conversation-view-switch"]')
    expect(viewbar.exists()).toBe(true)
    expect(viewbar.findAll('button').map(button => button.text())).toEqual(['新对话', '历史对话'])
    expect(viewbar.findAll('button')[0]?.classes()).toContain('is-active')
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    // 默认新对话不拉取历史，避免无谓请求。
    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
  })

  it('writes ?view=history and replaces the starter with the history view', async () => {
    const { wrapper } = await mountView(workspace())

    await wrapper.findAll('[data-testid="conversation-view-switch"] button')[1]?.trigger('click')
    await flushPromises()

    expect(router.replace).toHaveBeenCalledWith({ query: { view: 'history' } })
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    // 1B 历史视图默认按本人范围拉取。
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('restores the history view from a ?view=history deep link after the workspace resolves', async () => {
    route.query = { view: 'history' }
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('guides a startable member from an empty personal history back to the new conversation', async () => {
    route.query = { view: 'history' }
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue([{
      id: 'wam-1',
      agentId: 'agent-1',
      name: '订单分析助手',
      description: '分析订单数据',
      status: 'available',
      version: '1.0.0',
      addedBy: 'user-a',
      createdAt: '2026-09-09T10:00:00.000Z',
      allowedActions: ['start_conversation', 'disable', 'upgrade', 'remove'],
    }])
    vi.mocked(workbenchApi.listWorkspaceSessions).mockResolvedValue({ items: [], nextCursor: null })
    const { wrapper } = await mountView(workspace())
    await flushPromises()

    // 本人尚无会话：显示「本人尚无对话」。
    expect(wrapper.find('[data-testid="session-history-empty-own"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })

    // 可发起成员存在：引导回新对话并清掉 ?view=history。
    const back = wrapper.find('[data-testid="session-history-empty-own"] button')
    expect(back.text()).toBe('返回新对话')
    await back.trigger('click')
    await flushPromises()
    expect(router.replace).toHaveBeenCalledWith({ query: {} })
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
  })

  it('renders no team UI and issues no member query for a personal space (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
    }), { ownerName: '周航' })

    // AC-23 红线：个人空间不新增任何成员相关请求，也不渲染团队 UI。
    expect(workbenchApi.listWorkspaceAgentMembers).not.toHaveBeenCalled()
    expect(workbenchApi.listWorkspaceMembers).not.toHaveBeenCalled()
    expect(workbenchApi.listMemberCandidates).not.toHaveBeenCalled()
    // AC-23 红线：个人空间既不渲染「新对话／历史对话」切换，也不请求团队历史会话。
    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
    expect(wrapper.find('.member-dialog__body').exists()).toBe(false)
    expect(wrapper.find('.settings-dialog__body').exists()).toBe(false)
    // 个人空间右栏文案保持现状。
    expect(wrapper.text()).toContain('系统已为你创建唯一的默认个人空间')
  })

  it('ignores a ?view=history deep link on a personal space without any team request (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    route.query = { view: 'history' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
    }), { ownerName: '周航' })

    expect(workbenchApi.listWorkspaceSessions).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(false)
    // 新对话仍是唯一内容：个人空间行为与现状一致。
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(true)
  })
})

describe('WorkspaceDetailView 归档只读态（design §2.7 / AC-14 / AC-23）', () => {
  beforeEach(() => {
    route.params = { id: 'ws-team' }
    route.query = {}
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceMembers').mockResolvedValue({ items: [], currentUserRole: null })
    vi.spyOn(workbenchApi, 'listWorkspaceSessions').mockResolvedValue({ items: [], nextCursor: null })
  })

  const archivedFile = {
    id: 'file-1',
    name: '库存明细.xlsx',
    type: 'XLSX',
    size: '12 KB',
    uploadedBy: '林岚',
    uploadedAt: '2026-09-09 10:00',
  }
  const artifact: Artifact = {
    id: 'artifact-1',
    name: '季度报告.xlsx',
    type: 'xlsx',
    version: 1,
    size: '20 KB',
    createdAt: '2026-09-10 09:00',
    runId: 'run-1',
    workspaceId: 'ws-team',
    summary: '季度经营分析。',
  }

  function archivedWorkspace(overrides: Partial<Workspace> = {}) {
    return workspace({ status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z', ...overrides })
  }

  it('shows the read-only alert, hides the new-conversation entry and keeps history readable', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(archivedWorkspace())

    const alert = wrapper.find('[data-testid="workspace-archived-alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('该空间已归档，仅保留有权限的只读查看与下载')
    // 归档执行轨：新对话入口（含视图切换）不渲染。
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conversation-view-switch"]').exists()).toBe(false)
    // 内容本身不隐藏：历史对话仍可读。
    expect(wrapper.find('[data-testid="workspace-session-history"]').exists()).toBe(true)
    expect(workbenchApi.listWorkspaceSessions).toHaveBeenCalledWith('ws-team', { limit: 20 })
  })

  it('uses the archived empty state instead of the add-Agent guidance when the member has no history', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(archivedWorkspace())

    expect(wrapper.find('[data-testid="session-history-empty-archived"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('请联系负责人添加可用 Agent 成员')
  })

  it('hides upload entries but keeps shared files visible and readable when archived', async () => {
    route.query = { tab: 'files' }
    const { wrapper } = await mountView(archivedWorkspace({ files: [archivedFile] }))

    expect(wrapper.find('[data-testid="workspace-upload"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-upload-empty"]').exists()).toBe(false)
    // 文件内容与下载/查看入口不受影响；只隐藏指向新对话的引用入口。
    expect(wrapper.text()).toContain('库存明细.xlsx')
    expect(wrapper.text()).not.toContain('引用到对话')
  })

  it('keeps artifacts visible in an archived workspace', async () => {
    route.query = { tab: 'artifacts' }
    const { wrapper } = await mountView(archivedWorkspace(), { artifacts: [artifact] })

    expect(wrapper.text()).toContain('季度报告.xlsx')
  })

  it('offers 恢复空间 only to the owner and restores after confirmation', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-current', displayName: '周航', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'owner',
    })
    const restore = vi.spyOn(workbenchApi, 'restoreWorkspace').mockResolvedValue({
      id: 'ws-team',
      status: 'active',
      archivedAt: null,
    })
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const { wrapper } = await mountView(archivedWorkspace(), { ownerName: '周航' })

    const button = wrapper.find('[data-testid="workspace-restore"]')
    expect(button.exists()).toBe(true)
    await button.trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith('ws-team')
  })

  it('keeps the read-only alert but hides 恢复空间 from a non-owner member', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({
      items: [{ userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' }],
      currentUserRole: 'viewer',
    })
    const { wrapper } = await mountView(archivedWorkspace())

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
  })

  it('renders no archived alert on an active team space', async () => {
    vi.mocked(workbenchApi.listWorkspaceMembers).mockResolvedValue({ items: [], currentUserRole: 'owner' })
    const { wrapper } = await mountView(workspace())

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
    expect(wrapper.find('conversation-starter-stub').exists()).toBe(true)
  })

  it('shows no archived alert or restore entry on a personal space even if it carried the status (AC-23)', async () => {
    route.params = { id: 'ws-personal' }
    const { wrapper } = await mountView(workspace({
      id: 'ws-personal',
      type: 'personal',
      owner: '周航',
      members: ['周航'],
      memberCount: 1,
      status: 'archived',
    }), { ownerName: '周航' })

    expect(wrapper.find('[data-testid="workspace-archived-alert"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-restore"]').exists()).toBe(false)
  })
})
