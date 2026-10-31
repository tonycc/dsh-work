import { randomUUID } from 'node:crypto'

import type { DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

/** 站内通知方案 NC-S1 的通知类型；与迁移 0110 的 CHECK 约束一一对应。 */
export type UserNotificationKind = 'mention' | 'task_assigned' | 'task_completed' | 'workspace_member_added'

export type UserNotificationObjectType = 'message' | 'project_task' | 'workspace'

export interface UserNotificationInput {
  recipientUserId: string
  kind: UserNotificationKind
  workspaceId: string | null
  objectType: UserNotificationObjectType
  /** 跳转目标的安全引用：只传 ID，不传名称或正文。 */
  objectId: string
  actorUserId: string | null
  /** 业务发生的唯一标识；与接收人一起去重。 */
  dedupeKey: string
  /** 只放代码值（如 @ 所在的 sessionId），不放名称、正文或审核原因。 */
  metadata?: Record<string, string | number | boolean | null>
}

/**
 * 在调用方的业务事务中登记一条通知（与 `recordWorkspaceActivity` 同一约定）：业务提交则通知
 * 一并提交，回滚则不留通知；唯一键使重放成为空操作。触发人就是接收人本人时不登记——
 * 自己做的事不提醒自己。
 */
export async function recordUserNotification(
  transaction: DatabaseTransaction,
  input: UserNotificationInput,
): Promise<void> {
  if (input.actorUserId && input.actorUserId === input.recipientUserId) return
  await transaction`
    insert into user_notifications (
      id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id,
      actor_user_id, safe_metadata, dedupe_key
    ) values (
      ${`unotif-${randomUUID()}`}, ${tenantId}, ${input.recipientUserId}, ${input.kind}, ${input.workspaceId},
      ${input.objectType}, ${input.objectId}, ${input.actorUserId},
      ${transaction.json(input.metadata ?? {})}, ${input.dedupeKey}
    )
    on conflict (tenant_id, recipient_user_id, dedupe_key) do nothing
  `
}

/**
 * @ 提醒（D38）登记后，为同一条消息的每位接收人补写一条 `mention` 通知。接收人取自
 * `message_mentions`，因此与提醒的“现任成员、不含发送者”口径完全一致。
 */
export async function recordMentionNotifications(
  transaction: DatabaseTransaction,
  messageId: string,
): Promise<void> {
  await transaction`
    insert into user_notifications (
      id, tenant_id, recipient_user_id, kind, workspace_id, object_type, object_id,
      actor_user_id, safe_metadata, dedupe_key
    )
    select 'unotif-' || gen_random_uuid()::text, mm.tenant_id, mm.mentioned_user_id, 'mention', mm.workspace_id,
           'message', mm.message_id, mm.sender_user_id, jsonb_build_object('sessionId', mm.session_id),
           'mention:' || mm.message_id
      from message_mentions mm
     where mm.tenant_id = ${tenantId} and mm.message_id = ${messageId}
    on conflict (tenant_id, recipient_user_id, dedupe_key) do nothing
  `
}

/** 打开群组或讨论把 @ 提醒标为已读时，同步这些消息的 `mention` 通知（方案 NC4）。 */
export async function markMentionNotificationsRead(
  transaction: DatabaseTransaction,
  userId: string,
  messageIds: string[],
): Promise<void> {
  if (!messageIds.length) return
  await transaction`
    update user_notifications set read_at = now()
     where tenant_id = ${tenantId} and recipient_user_id = ${userId} and kind = 'mention'
       and object_id in ${transaction(messageIds)} and read_at is null
  `
}
