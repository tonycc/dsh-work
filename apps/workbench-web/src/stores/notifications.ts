import { ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { UserNotification } from '../types/domain'

export type NotificationTab = 'all' | 'unread'

/**
 * 站内通知（方案 NC-S2）：铃铛角标的未读数与面板中的通知列表。未读数与“未读”页签同一口径，
 * 均以服务端为准；本地只在标记已读后先行扣减，失败时由下次刷新纠正。迟到的旧请求不覆盖新结果。
 */
export const useNotificationStore = defineStore('workbench-notifications', () => {
  const unread = ref(0)
  const items = ref<UserNotification[]>([])
  const nextCursor = ref<string | null>(null)
  const tab = ref<NotificationTab>('all')
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  let generation = 0

  /** 只刷新角标：轮询与页面重新可见时调用。失败不打扰用户，保留上一次的数字。 */
  async function refreshUnread() {
    try {
      unread.value = (await workbenchApi.getNotificationUnreadCount()).unread
    } catch {
      // 角标刷新失败时保留原值，下次轮询再取。
    }
  }

  async function load(nextTab: NotificationTab = tab.value) {
    const current = ++generation
    tab.value = nextTab
    loading.value = true
    error.value = ''
    try {
      const [page] = await Promise.all([workbenchApi.listNotifications({ status: nextTab }), refreshUnread()])
      if (current !== generation) return
      items.value = page.items
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '通知加载失败'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function loadMore() {
    if (!nextCursor.value || loadingMore.value) return
    const current = generation
    loadingMore.value = true
    try {
      const page = await workbenchApi.listNotifications({ status: tab.value, cursor: nextCursor.value })
      if (current !== generation) return
      const known = new Set(items.value.map(item => item.id))
      items.value = [...items.value, ...page.items.filter(item => !known.has(item.id))]
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current === generation) error.value = cause instanceof Error ? cause.message : '通知加载失败'
    } finally {
      loadingMore.value = false
    }
  }

  /** 点开一条：本地先标为已读并扣减角标（只扣仍计入未读的），再写服务端。 */
  async function markRead(item: UserNotification) {
    if (item.read) return
    item.read = true
    if (item.visible && unread.value > 0) unread.value--
    try {
      await workbenchApi.markNotificationRead(item.id)
    } catch {
      // 写入失败不阻断跳转：下次刷新会重新显示未读。
    }
    await refreshUnread()
  }

  async function markAllRead() {
    await workbenchApi.markAllNotificationsRead()
    for (const item of items.value) item.read = true
    if (tab.value === 'unread') items.value = []
    nextCursor.value = tab.value === 'unread' ? null : nextCursor.value
    unread.value = 0
  }

  function reset() {
    generation++
    unread.value = 0
    items.value = []
    nextCursor.value = null
    tab.value = 'all'
    loading.value = false
    loadingMore.value = false
    error.value = ''
  }

  return { unread, items, nextCursor, tab, loading, loadingMore, error, refreshUnread, load, loadMore, markRead, markAllRead, reset }
})
