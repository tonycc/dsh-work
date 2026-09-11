import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { ElSelect } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { Workspace, WorkspaceMember } from '@/types/domain'
import WorkspaceSettingsDialog from './WorkspaceSettingsDialog.vue'

const members: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: 'u-owner-2', displayName: '郑野', role: 'owner', joinedAt: '2026-09-01T06:00:00.000Z' },
  { userId: 'u-admin', displayName: '周航', role: 'admin', joinedAt: '2026-09-02T00:00:00.000Z' },
  { userId: 'u-member', displayName: '陈默', role: 'member', joinedAt: '2026-09-03T00:00:00.000Z' },
]

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-team',
    name: '供应链协作空间',
    description: '团队共享的协作空间。',
    type: 'team',
    memberCount: 4,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚', '周航', '陈默'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(WorkspaceSettingsDialog, {
    props: {
      open: true,
      workspaceId: 'ws-team',
      workspaceName: '供应链团队',
      workspaceDescription: '团队共享的协作空间。',
      currentUserRole: 'owner',
      members,
      ...props,
    },
    global: { plugins: [ElementPlus] },
  })
}

function panelOf(wrapper: ReturnType<typeof mountDialog>) {
  return wrapper.find('.settings-dialog__body')
}

async function selectTransferTarget(panel: ReturnType<typeof panelOf>, userId: string) {
  panel.findComponent(ElSelect).vm.$emit('update:modelValue', userId)
  await flushPromises()
}

describe('WorkspaceSettingsDialog', () => {
  beforeEach(() => {
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
  })

  it('renders a 空间设置 dialog with name and description fields for the owner', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(wrapper.text()).toContain('空间设置')
    expect(panel.find('[data-testid="settings-name"]').exists()).toBe(true)
    expect(panel.find('[data-testid="settings-description"]').exists()).toBe(true)
    expect(panel.find('[data-testid="settings-save"]').exists()).toBe(true)
    expect(panel.find('[data-testid="settings-transfer"]').exists()).toBe(true)
    // 退出区对负责人同样呈现，但唯一负责人会被引导先转交（TW-01）。
    expect(panel.find('[data-testid="settings-exit"]').exists()).toBe(true)
  })

  it('saves the edited name and a null description through PATCH /workspaces/:id', async () => {
    const updated = workspace()
    const update = vi.spyOn(workbenchApi, 'updateWorkspace').mockResolvedValue(updated)
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await panel.find('[data-testid="settings-name"]').setValue('供应链协作空间')
    await panel.find('[data-testid="settings-description"]').setValue('')
    await panel.find('[data-testid="settings-save"]').trigger('click')
    await flushPromises()

    expect(update).toHaveBeenCalledWith('ws-team', { name: '供应链协作空间', description: null })
    expect(wrapper.emitted('saved')?.at(-1)).toEqual([updated])
  })

  it('blocks a name shorter than 2 characters before calling the server', async () => {
    const update = vi.spyOn(workbenchApi, 'updateWorkspace')
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await panel.find('[data-testid="settings-name"]').setValue('供')
    await panel.find('[data-testid="settings-save"]').trigger('click')
    await flushPromises()

    expect(update).not.toHaveBeenCalled()
  })

  it('keeps settings read-only for admins and members, showing only their exit action', async () => {
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.find('[data-testid="settings-name"]').attributes('disabled')).toBeDefined()
    expect(panel.find('[data-testid="settings-save"]').exists()).toBe(false)
    expect(panel.find('[data-testid="settings-transfer"]').exists()).toBe(false)
    expect(panel.find('[data-testid="settings-exit"]').exists()).toBe(true)
    expect(panel.text()).toContain('贡献')
  })

  it('transfers ownership to another member after confirmation', async () => {
    const transfer = vi.spyOn(workbenchApi, 'transferWorkspaceOwner').mockResolvedValue({
      workspaceId: 'ws-team',
      previousOwnerId: 'u-owner',
      newOwnerId: 'u-member',
    })
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await selectTransferTarget(panel, 'u-member')
    await panel.find('[data-testid="settings-transfer-confirm"]').trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(vi.mocked(ElMessageBox.confirm).mock.calls[0]?.[0]).toContain('普通成员')
    expect(transfer).toHaveBeenCalledWith('ws-team', { toUserId: 'u-member' })
    expect(wrapper.emitted('transferred')).toBeTruthy()
  })

  it('does not transfer when the confirmation is cancelled', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValue(new Error('cancel'))
    const transfer = vi.spyOn(workbenchApi, 'transferWorkspaceOwner')
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await selectTransferTarget(panel, 'u-member')
    await panel.find('[data-testid="settings-transfer-confirm"]').trigger('click')
    await flushPromises()

    expect(transfer).not.toHaveBeenCalled()
  })

  it('blocks exit for the only owner and requires a transfer first (TW-01)', async () => {
    const exit = vi.spyOn(workbenchApi, 'exitWorkspace')
    const wrapper = mountDialog({ currentUserRole: 'owner', members: [members[0]!] })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.find('[data-testid="settings-exit"]').exists()).toBe(true)
    await panel.find('[data-testid="settings-exit"]').trigger('click')
    await flushPromises()

    expect(panel.text()).toContain('需先转交负责人')
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits the workspace after confirmation for a non-owner member', async () => {
    const exit = vi.spyOn(workbenchApi, 'exitWorkspace').mockResolvedValue({ workspaceId: 'ws-team', exited: true })
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="settings-exit"]').trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith('ws-team')
    expect(wrapper.emitted('exited')).toBeTruthy()
  })

  it('archives the workspace only for the owner and only after a second confirmation', async () => {
    const archive = vi.spyOn(workbenchApi, 'archiveWorkspace').mockResolvedValue({
      id: 'ws-team',
      status: 'archived',
      archivedAt: '2026-09-11T00:00:00.000Z',
    })
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.find('[data-testid="settings-archive"]').exists()).toBe(true)
    expect(panel.find('[data-testid="settings-restore"]').exists()).toBe(false)

    await panel.find('[data-testid="settings-archive-confirm"]').trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(archive).toHaveBeenCalledWith('ws-team')
    expect(wrapper.emitted('archive-changed')).toBeTruthy()
  })

  it('does not archive when the second confirmation is cancelled', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValue(new Error('cancel'))
    const archive = vi.spyOn(workbenchApi, 'archiveWorkspace')
    const wrapper = mountDialog()
    await flushPromises()

    await panelOf(wrapper).find('[data-testid="settings-archive-confirm"]').trigger('click')
    await flushPromises()

    expect(archive).not.toHaveBeenCalled()
    expect(wrapper.emitted('archive-changed')).toBeFalsy()
  })

  it('surfaces the wait-or-cancel hint when archive conflicts with queued or running runs (409)', async () => {
    vi.spyOn(workbenchApi, 'archiveWorkspace').mockRejectedValue(new WorkbenchApiError({
      code: 'state_conflict',
      message: '该空间还有 2 个排队或运行中的任务，不能归档；请等待任务完成或先取消任务',
    }, 409, '归档空间失败'))
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await panel.find('[data-testid="settings-archive-confirm"]').trigger('click')
    await flushPromises()

    const hint = panel.find('[data-testid="settings-archive-conflict"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('2 个排队或运行中')
    expect(hint.text()).toContain('请等待')
    expect(hint.text()).toContain('先取消')
    expect(wrapper.emitted('archive-changed')).toBeFalsy()
  })

  it('shows no archive or restore entry to a non-owner member', async () => {
    const wrapper = mountDialog({ currentUserRole: 'member' })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.find('[data-testid="settings-archive"]').exists()).toBe(false)
    expect(panel.find('[data-testid="settings-restore"]').exists()).toBe(false)
  })

  it('offers the archived-state restore entry and restores after confirmation', async () => {
    const restore = vi.spyOn(workbenchApi, 'restoreWorkspace').mockResolvedValue({
      id: 'ws-team',
      status: 'active',
      archivedAt: null,
    })
    const wrapper = mountDialog({ workspaceStatus: 'archived' })
    await flushPromises()
    const panel = panelOf(wrapper)

    expect(panel.find('[data-testid="settings-archive"]').exists()).toBe(false)
    expect(panel.find('[data-testid="settings-restore"]').exists()).toBe(true)
    // 归档空间属执行轨：名称/说明不可保存。
    expect(panel.find('[data-testid="settings-save"]').exists()).toBe(false)

    await panel.find('[data-testid="settings-restore-confirm"]').trigger('click')
    await flushPromises()

    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith('ws-team')
    expect(wrapper.emitted('archive-changed')).toBeTruthy()
  })
})
