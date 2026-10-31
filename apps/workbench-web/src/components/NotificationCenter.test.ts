import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useUiModeStore } from '@/stores/ui-mode'
import type { UserNotification } from '@/types/domain'
import NotificationCenter from './NotificationCenter.vue'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getNotificationUnreadCount: vi.fn(),
    listNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}))

const supply = { id: 'ws-supply', name: '供应链经营分析' }
const notifications: UserNotification[] = [
  {
    id: 'n-mention', kind: 'mention', createdAt: new Date().toISOString(), read: false, visible: true,
    actor: { id: 'U2', name: '周敏' }, workspace: supply, objectName: null,
    target: { type: 'message', id: 'msg-1', sessionId: 'session-1' },
  },
  {
    id: 'n-task', kind: 'task_assigned', createdAt: new Date().toISOString(), read: true, visible: true,
    actor: { id: 'U2', name: '周敏' }, workspace: supply, objectName: '核对库存',
    target: { type: 'project_task', id: 'ptask-1', sessionId: null },
  },
  {
    id: 'n-hidden', kind: 'task_completed', createdAt: new Date().toISOString(), read: true, visible: false,
    actor: null, workspace: null, objectName: null, target: null,
  },
]

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

async function setup(unread = 1) {
  vi.mocked(workbenchApi.getNotificationUnreadCount).mockResolvedValue({ unread })
  vi.mocked(workbenchApi.listNotifications).mockImplementation(async query =>
    ({ items: (query?.status === 'unread' ? notifications.filter(item => !item.read) : notifications).map(item => ({ ...item })), nextCursor: null }))
  vi.mocked(workbenchApi.markNotificationRead).mockResolvedValue({ id: 'n', read: true })
  vi.mocked(workbenchApi.markAllNotificationsRead).mockResolvedValue({ read: 1 })
  const pinia = createPinia()
  setActivePinia(pinia)
  const page = { template: '<div>页面</div>' }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/workbench', component: page },
      { path: '/workspaces/:id', name: 'workspace-detail', component: page, children: [
        { path: 'conversations/:conversationId', name: 'workspace-conversation', component: page },
        { path: 'tasks/:taskId', name: 'workspace-task', component: page },
      ] },
      { path: '/c/chats/group/:id', name: 'collab-group-chat', component: page },
    ],
  })
  await router.push('/workbench')
  await router.isReady()
  const wrapper = mount(NotificationCenter, { props: { panelLeft: '236px' }, attachTo: document.body, global: { plugins: [pinia, router, ElementPlus] } })
  await flushPromises()
  return { wrapper, router }
}

function panel() {
  return document.body.querySelector('[role="dialog"][aria-label="通知"]')
}

function itemButton(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.notification-item')].find(button => button.getAttribute('aria-label')?.includes(label))
}

describe('NotificationCenter', () => {
  it('shows the unread count on the bell and lists notifications with names in bold', async () => {
    const { wrapper } = await setup(3)
    const bell = wrapper.get('[data-testid="notification-bell"]')
    expect(bell.attributes('aria-label')).toBe('通知，3 条未读')
    expect(bell.text()).toContain('3')

    await bell.trigger('click')
    await flushPromises()
    expect(panel()).not.toBeNull()
    expect(itemButton('周敏 在 「供应链经营分析」 中 @ 了你')?.getAttribute('aria-label')).toMatch(/^未读：/)
    expect(itemButton('周敏 把任务 「核对库存」 指派给你')?.querySelectorAll('strong')).toHaveLength(2)
    expect(itemButton('一条通知（该内容已不可见）')).toBeDefined()
    wrapper.unmount()
  })

  it('hides the badge when nothing is unread', async () => {
    const { wrapper } = await setup(0)
    const bell = wrapper.get('[data-testid="notification-bell"]')
    expect(bell.attributes('aria-label')).toBe('通知')
    expect(bell.find('.notification-bell__badge').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens a mention as the discussion in work mode and as the group chat in collaboration mode', async () => {
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(workbenchApi.markNotificationRead).toHaveBeenCalledWith('n-mention')
    expect(router.currentRoute.value.fullPath).toBe('/workspaces/ws-supply/conversations/session-1')
    expect(panel()).toBeNull()
    expect(wrapper.emitted('navigate')).toHaveLength(1)

    useUiModeStore().mode = 'collab'
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('中 @ 了你')!.click()
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/c/chats/group/ws-supply')
    wrapper.unmount()
  })

  it('does not navigate for a notification that is no longer visible', async () => {
    const warning = vi.spyOn(ElMessage, 'warning')
    const { wrapper, router } = await setup()
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    itemButton('该内容已不可见')!.click()
    await flushPromises()
    expect(warning).toHaveBeenCalledWith('该内容已不可见')
    expect(router.currentRoute.value.fullPath).toBe('/workbench')
    expect(panel()).not.toBeNull()
    wrapper.unmount()
  })

  it('marks everything read and shows the empty unread tab', async () => {
    const { wrapper } = await setup(1)
    await wrapper.get('[data-testid="notification-bell"]').trigger('click')
    await flushPromises()
    const readAll = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('全部标为已读'))
    readAll!.click()
    await flushPromises()
    expect(workbenchApi.markAllNotificationsRead).toHaveBeenCalled()
    expect(wrapper.get('[data-testid="notification-bell"]').attributes('aria-label')).toBe('通知')

    vi.mocked(workbenchApi.listNotifications).mockResolvedValue({ items: [], nextCursor: null })
    const unreadTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.trim() === '未读')
    unreadTab!.click()
    await flushPromises()
    expect(panel()?.textContent).toContain('暂时没有未读通知')
    wrapper.unmount()
  })
})
