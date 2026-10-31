import type { RouteLocationRaw } from 'vue-router'

import type { UiMode, UserNotification } from '@/types/domain'

/** 通知正文的片段：`strong` 为人名与对象名，界面加粗显示。 */
export interface NotificationTextPart {
  text: string
  strong?: boolean
}

/**
 * 通知正文（方案第 4 节）：只写“谁、在哪个项目/对象、做了什么”，名称由服务端按本人当前权限解析。
 * 已不可见的通知不显示任何名称。
 */
export function notificationText(item: UserNotification): NotificationTextPart[] {
  if (!item.visible) return [{ text: '一条通知（该内容已不可见）' }]
  const actor = item.actor?.name || '有人'
  const workspace = item.workspace?.name ?? ''
  const object = item.objectName ?? ''
  switch (item.kind) {
    case 'mention':
      return [{ text: actor, strong: true }, { text: ' 在 ' }, { text: `「${workspace}」`, strong: true }, { text: ' 中 @ 了你' }]
    case 'task_assigned':
      return [{ text: actor, strong: true }, { text: ' 把任务 ' }, { text: `「${object}」`, strong: true }, { text: ' 指派给你' }]
    case 'task_completed':
      return [{ text: actor, strong: true }, { text: ' 完成了你创建的任务 ' }, { text: `「${object}」`, strong: true }]
    case 'workspace_member_added':
      return [{ text: actor, strong: true }, { text: ' 把你加入了项目 ' }, { text: `「${workspace}」`, strong: true }]
  }
}

/** 无障碍名称与测试用的纯文本正文。 */
export function notificationPlainText(item: UserNotification): string {
  return notificationText(item).map(part => part.text).join('')
}

/** 类型图标的短标记（不用表情符号）。 */
export function notificationGlyph(item: UserNotification): string {
  if (!item.visible) return '–'
  return { mention: '@', task_assigned: '任', task_completed: '任', workspace_member_added: '员' }[item.kind]
}

/**
 * 点击通知去往的地址。任务与项目使用 A 工作模式的地址，B 中由路由守卫映射到群组对应页
 * （mode-routes）；@ 我在 A 中打开该讨论，在 B 中打开群聊（讨论消息在群聊中）。
 * 不可见的通知没有去向。
 */
export function notificationLocation(item: UserNotification, mode: UiMode): RouteLocationRaw | null {
  if (!item.visible || !item.target || !item.workspace) return null
  const workspaceId = item.workspace.id
  switch (item.target.type) {
    case 'message':
      if (mode === 'collab' || !item.target.sessionId) return { name: 'collab-group-chat', params: { id: workspaceId } }
      return { name: 'workspace-conversation', params: { id: workspaceId, conversationId: item.target.sessionId } }
    case 'project_task':
      return { name: 'workspace-task', params: { id: workspaceId, taskId: item.target.id } }
    case 'workspace':
      return { name: 'workspace-detail', params: { id: workspaceId } }
  }
}
