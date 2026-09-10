import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { ElOption, ElSelect, ElTooltip } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceAgentMember, WorkspaceMember } from '@/types/domain'
import WorkspaceMemberDialog from './WorkspaceMemberDialog.vue'

const employees: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: 'u-owner-2', displayName: '郑野', role: 'owner', joinedAt: '2026-09-01T06:00:00.000Z' },
  { userId: 'u-admin', displayName: '周航', role: 'admin', joinedAt: '2026-09-02T00:00:00.000Z' },
  { userId: 'u-member', displayName: '陈默', role: 'member', joinedAt: '2026-09-03T00:00:00.000Z' },
  { userId: 'u-viewer', displayName: '苏晚', role: 'viewer', joinedAt: '2026-09-04T00:00:00.000Z' },
]

const agents: WorkspaceAgentMember[] = [
  {
    id: 'wam-1',
    agentId: 'agent-1',
    name: '订单分析助手',
    description: '分析订单波动与异常。',
    status: 'available',
    version: 'v2',
    addedBy: '林岚',
    createdAt: '2026-09-05T00:00:00.000Z',
    allowedActions: ['start_conversation', 'disable', 'upgrade', 'remove'],
  },
  {
    id: 'wam-2',
    agentId: 'agent-2',
    name: '库存巡检助手',
    description: '巡检库存水位。',
    status: 'disabled',
    version: 'v1',
    addedBy: '林岚',
    createdAt: '2026-09-06T00:00:00.000Z',
    allowedActions: ['enable', 'remove'],
  },
]

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceMemberDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      currentUserRole: 'owner',
      members: employees,
      agentMembers: agents,
      // 默认直接用 props 驱动渲染；单独的用例验证 `open` 时的服务端加载。
      loadAgentMembers: false,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

/** el-dialog teleports by default; the component opts out so the panel is queryable. */
function panelOf(wrapper: ReturnType<typeof mountDialog>) {
  return wrapper.find('.member-dialog__body')
}

describe('WorkspaceMemberDialog', () => {
  beforeEach(() => {
    vi.spyOn(workbenchApi, 'listMemberCandidates').mockResolvedValue({ items: [], nextCursor: null })
    vi.spyOn(workbenchApi, 'listWorkspaceAgentMembers').mockResolvedValue([])
    vi.spyOn(workbenchApi, 'listWorkspaceAgentCandidates').mockResolvedValue({ items: [], nextCursor: null })
  })

  it('loads Agent members from the API when the dialog opens', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue(agents)
    const wrapper = mountDialog({ agentMembers: [], loadAgentMembers: true })
    await flushPromises()

    expect(workbenchApi.listWorkspaceAgentMembers).toHaveBeenCalledWith('ws-team')
    expect(panelOf(wrapper).findAll('[data-testid="agent-member-row"]')).toHaveLength(2)
  })

  it('renders employee and Agent segments in one dialog with a close footer', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(wrapper.text()).toContain('管理成员')
    expect(panel.find('[data-testid="member-section-employee"]').exists()).toBe(true)
    expect(panel.find('[data-testid="member-section-agent"]').exists()).toBe(true)
    expect(panel.findAll('[data-testid="member-role-select"]')).toHaveLength(5)
    expect(panel.findAll('[data-testid="agent-member-row"]')).toHaveLength(2)

    const close = panel.find('[data-testid="member-dialog-close"]')
    expect(close.exists()).toBe(true)
    await close.trigger('click')
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('never renders an "可用能力" entry (plan 3.2 / AC-18)', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.text()).not.toContain('可用能力')
  })

  it('excludes already joined employees from the add-employee search results', async () => {
    vi.mocked(workbenchApi.listMemberCandidates).mockResolvedValue({
      items: [
        { id: 'u-member', displayName: '陈默', department: '计划部' },
        { id: 'u-new', displayName: '何雨', department: '采购部' },
      ],
      nextCursor: null,
    })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-candidate-search"]').setValue('何')
    await new Promise(resolve => setTimeout(resolve, 350))
    await flushPromises()

    expect(workbenchApi.listMemberCandidates).toHaveBeenCalledWith('ws-team', { query: '何', limit: 10 })
    const results = panelOf(wrapper).findAll('[data-testid="member-candidate-row"]')
    expect(results.map(row => row.find('.member-dialog__copy').text())).toEqual(['何雨采购部'])
  })

  it('adds a searched employee with the selected role (server-side paging respected)', async () => {
    vi.mocked(workbenchApi.listMemberCandidates).mockResolvedValue({
      items: [{ id: 'u-new', displayName: '何雨', department: '采购部' }],
      nextCursor: null,
    })
    const addMember = vi.spyOn(workbenchApi, 'addWorkspaceMember').mockResolvedValue({
      userId: 'u-new',
      displayName: '何雨',
      role: 'member',
      joinedAt: '2026-09-10T00:00:00.000Z',
    })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-candidate-search"]').setValue('何')
    await new Promise(resolve => setTimeout(resolve, 350))
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-candidate-row"] button').trigger('click')
    await flushPromises()

    expect(addMember).toHaveBeenCalledWith('ws-team', { userId: 'u-new', role: 'member' })
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('keeps a trailing cursor to load more employee candidates', async () => {
    vi.mocked(workbenchApi.listMemberCandidates)
      .mockResolvedValueOnce({
        items: [{ id: 'u-a', displayName: '何雨', department: '采购部' }],
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        items: [{ id: 'u-b', displayName: '何晴', department: '财务部' }],
        nextCursor: null,
      })
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-employee"]').trigger('click')
    await flushPromises()

    const loadMore = panelOf(wrapper).find('[data-testid="member-candidate-more"]')
    expect(loadMore.exists()).toBe(true)
    await loadMore.trigger('click')
    await flushPromises()

    expect(workbenchApi.listMemberCandidates).toHaveBeenLastCalledWith('ws-team', { cursor: 'cursor-1', limit: 10 })
    const names = panelOf(wrapper)
      .findAll('[data-testid="member-candidate-row"]')
      .map(row => row.find('.member-dialog__copy').text())
    expect(names).toEqual(['何雨采购部', '何晴财务部'])
  })

  it('lets the owner change any role and remove any member', async () => {
    const changeRole = vi.spyOn(workbenchApi, 'updateMemberRole').mockResolvedValue({
      userId: 'u-member',
      displayName: '陈默',
      role: 'admin',
      joinedAt: '2026-09-03T00:00:00.000Z',
    })
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    const memberSelect = panelOf(wrapper).findAllComponents(ElSelect)[3]
    const options = memberSelect.findAllComponents(ElOption)
    expect(options.map(option => option.props('value'))).toEqual(['owner', 'admin', 'member', 'viewer'])
    memberSelect.vm.$emit('change', 'admin')
    await flushPromises()
    expect(changeRole).toHaveBeenCalledWith('ws-team', 'u-member', { role: 'admin' })
  })

  it('restricts an admin to member/viewer roles and disables self and other admins', async () => {
    const wrapper = mountDialog({ currentUserRole: 'admin' })
    await flushPromises()
    const selects = panelOf(wrapper).findAllComponents(ElSelect)

    // 两位负责人：管理员不能任免负责人。
    expect(selects[0].props('disabled')).toBe(true)
    expect(selects[1].props('disabled')).toBe(true)
    // 自己所在行。
    expect(selects[2].props('disabled')).toBe(true)
    // 成员/只读成员行只提供两个可选项。
    expect(selects[3].findAllComponents(ElOption).map(option => option.props('value'))).toEqual(['member', 'viewer'])
    expect(selects[4].findAllComponents(ElOption).map(option => option.props('value'))).toEqual(['member', 'viewer'])
    expect(panelOf(wrapper).findAll('[data-testid="member-remove"]')).toHaveLength(0)
  })

  it('renders a bare read-only employee list for plain members', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentMembers).mockResolvedValue(agents)
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.findAll('[data-testid="member-role-select"]')).toHaveLength(0)
    expect(panel.findAll('[data-testid="member-remove"]')).toHaveLength(0)
    expect(panel.find('[data-testid="member-add-employee"]').exists()).toBe(false)
    expect(panel.find('[data-testid="member-role-readonly"]').exists()).toBe(true)
  })

  it('marks the only owner as unique and blocks role change and removal', async () => {
    const wrapper = mountDialog({ members: [employees[0]!], currentUserRole: 'owner' })
    await flushPromises()
    const panel = panelOf(wrapper)

    const select = panel.findComponent(ElSelect)
    expect(select.props('disabled')).toBe(true)
    expect(select.props('modelValue')).toBe('owner')
    expect(panel.find('[data-testid="member-role-unique"]').text()).toContain('负责人（唯一）')
    expect(panel.find('[data-testid="member-remove"]').exists()).toBe(false)
  })

  it('confirms removal before calling the API', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceMember').mockResolvedValue({ userId: 'u-viewer', removed: true })
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).findAll('[data-testid="member-remove"]')[4].trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('ws-team', 'u-viewer')
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('does not call the API when removal is cancelled', async () => {
    vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(new Error('cancel'))
    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceMember')
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).findAll('[data-testid="member-remove"]')[4].trigger('click')
    await flushPromises()

    expect(remove).not.toHaveBeenCalled()
  })

  it('renders only server-allowed Agent actions and starts a conversation from the row', async () => {
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()
    const rows = panelOf(wrapper).findAll('[data-testid="agent-member-row"]')

    // 只读行由服务端 allowedActions 决定：成员没有管理动作，只有开始对话。
    expect(rows[0]?.find('[data-testid="agent-start-conversation"]').exists()).toBe(true)
    expect(rows[0]?.find('[data-testid="agent-action-disable"]').exists()).toBe(false)
    expect(rows[0]?.find('[data-testid="agent-action-remove"]').exists()).toBe(false)
    // 已停用且服务端未返回 start_conversation 时不渲染开始对话。
    expect(rows[1]?.find('[data-testid="agent-start-conversation"]').exists()).toBe(false)
    expect(rows[1]?.find('[data-testid="agent-action-enable"]').exists()).toBe(true)

    await rows[0]!.find('[data-testid="agent-start-conversation"]').trigger('click')
    expect(wrapper.emitted('start-conversation')?.at(-1)).toEqual(['wam-1'])
  })

  it('confirms Agent lifecycle actions with the in-flight convergence warning', async () => {
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const update = vi.spyOn(workbenchApi, 'updateWorkspaceAgentMember').mockResolvedValue(agents[0]!)
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="agent-action-disable"]').trigger('click')
    await flushPromises()

    expect(confirm.mock.calls[0]?.[0]).toContain('在途运行')
    expect(update).toHaveBeenCalledWith('ws-team', 'wam-1', { action: 'disable' })
    expect(wrapper.emitted('refresh')).toBeTruthy()

    const remove = vi.spyOn(workbenchApi, 'removeWorkspaceAgentMember').mockResolvedValue({ id: 'wam-2', removed: true })
    await panelOf(wrapper).findAll('[data-testid="agent-action-remove"]')[1].trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('ws-team', 'wam-2')
  })

  it('shows the unavailable reason inline when the service reports one', async () => {
    const wrapper = mountDialog({
      agentMembers: [{
        ...agents[0]!,
        status: 'disabled',
        allowedActions: ['remove'],
        unavailableReason: '版本失效：平台已撤权',
      }],
    })
    await flushPromises()

    const status = panelOf(wrapper).find('[data-testid="agent-status-tooltip"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('aria-label')).toBe('Agent 状态：已停用')
    const tooltip = wrapper.findAllComponents(ElTooltip)[0]
    expect(tooltip?.props('content')).toContain('平台已撤权')
  })

  it('renders empty states with role-aware guidance', async () => {
    const ownerView = mountDialog({ members: [], agentMembers: [], currentUserRole: 'owner' })
    await flushPromises()
    expect(panelOf(ownerView).text()).toContain('尚未添加员工')
    expect(panelOf(ownerView).text()).toContain('尚未加入 Agent')
    expect(panelOf(ownerView).find('[data-testid="member-add-agent"]').exists()).toBe(true)

    const memberView = mountDialog({ members: [], agentMembers: [], currentUserRole: 'member' })
    await flushPromises()
    expect(panelOf(memberView).text()).toContain('请联系负责人')
    expect(panelOf(memberView).find('[data-testid="member-add-agent"]').exists()).toBe(false)
  })

  it('runs the add-Agent confirmation flow with detail before joining', async () => {
    vi.mocked(workbenchApi.listWorkspaceAgentCandidates).mockResolvedValue({
      items: [{
        agentId: 'agent-9',
        name: '排产助手',
        description: '生成排产建议。',
        activeVersionId: 'av-9',
        activeVersion: 'v1',
        status: 'published',
      }],
      nextCursor: null,
    })
    const addAgent = vi.spyOn(workbenchApi, 'addWorkspaceAgentMember').mockResolvedValue(agents[0]!)
    const wrapper = mountDialog({ currentUserRole: 'owner' })
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="member-add-agent"]').trigger('click')
    await panelOf(wrapper).find('[data-testid="member-agent-search"]').setValue('排产')
    await new Promise(resolve => setTimeout(resolve, 350))
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="agent-candidate-row"] button').trigger('click')
    await flushPromises()

    const detail = panelOf(wrapper).find('[data-testid="agent-candidate-detail"]')
    expect(detail.exists()).toBe(true)
    expect(detail.text()).toContain('职责')
    expect(detail.text()).toContain('关联技能')
    expect(detail.text()).toContain('所需工具')
    expect(detail.text()).toContain('数据范围')
    expect(addAgent).not.toHaveBeenCalled()

    await detail.find('[data-testid="agent-candidate-confirm"]').trigger('click')
    await flushPromises()
    expect(addAgent).toHaveBeenCalledWith('ws-team', { agentId: 'agent-9' })
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })

  it('does not query the API while the dialog is closed', async () => {
    const load = vi.mocked(workbenchApi.listWorkspaceAgentMembers)
    const wrapper = mountDialog({ open: false, loadAgentMembers: true })
    await flushPromises()

    expect(load).not.toHaveBeenCalled()

    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(load).toHaveBeenCalledWith('ws-team')
  })
})
