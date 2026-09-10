import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { ElSelect } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { WorkspaceMember } from '@/types/domain'
import WorkspaceSettingsDialog from './WorkspaceSettingsDialog.vue'

const members: WorkspaceMember[] = [
  { userId: 'u-owner', displayName: '林岚', role: 'owner', joinedAt: '2026-09-01T00:00:00.000Z' },
  { userId: 'u-owner-2', displayName: '郑野', role: 'owner', joinedAt: '2026-09-01T06:00:00.000Z' },
  { userId: 'u-admin', displayName: '周航', role: 'admin', joinedAt: '2026-09-02T00:00:00.000Z' },
  { userId: 'u-member', displayName: '陈默', role: 'member', joinedAt: '2026-09-03T00:00:00.000Z' },
]

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

  it('emits the edited name and a null description when the owner clears it (plan 3.3)', async () => {
    const wrapper = mountDialog()
    await flushPromises()
    const panel = panelOf(wrapper)

    await panel.find('[data-testid="settings-name"]').setValue('供应链协作空间')
    await panel.find('[data-testid="settings-description"]').setValue('')
    await panel.find('[data-testid="settings-save"]').trigger('click')

    expect(wrapper.emitted('save')?.at(-1)).toEqual([{ name: '供应链协作空间', description: null }])
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

  it('offers no archive action in batch 1A', async () => {
    const wrapper = mountDialog()
    await flushPromises()

    expect(wrapper.text()).not.toContain('归档空间')
  })
})
