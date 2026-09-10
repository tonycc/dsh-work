import ElementPlus, { ElDialog } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { Workspace } from '@/types/domain'
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
    ...overrides,
  }
}

async function mountView(item: Workspace, options: { ownerName?: string } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const contentStore = useContentStore(pinia)
  contentStore.workspaces.splice(0, contentStore.workspaces.length, item)
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
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listMemberCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceAgentCandidates').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('renders the Agent segment for a team space and loads members via the T4 API', async () => {
    const { wrapper } = await mountView(workspace())

    expect(workbenchApi.listWorkspaceAgentMembers).toHaveBeenCalledWith('ws-team')
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(true)
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
    expect(workbenchApi.listMemberCandidates).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="panel-agent-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-employee-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-manage-members"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-workspace-settings"]').exists()).toBe(false)
    expect(wrapper.find('.member-dialog__body').exists()).toBe(false)
    expect(wrapper.find('.settings-dialog__body').exists()).toBe(false)
    // 个人空间右栏文案保持现状。
    expect(wrapper.text()).toContain('系统已为你创建唯一的默认个人空间')
  })
})
