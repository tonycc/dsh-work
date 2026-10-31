import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { requestInvalid } from '../../../domain/authorization-errors.ts'
import { notFound } from '../../../domain/request-errors.ts'
import { readableWorkspacePredicate } from './postgres-workspace-service.ts'
import type { UserNotificationKind, UserNotificationObjectType } from './user-notification-writer.ts'

const tenantId = 'tenant-dsh-work'

/** 方案 NC4：只保留最近 90 天的通知；更早的不再列出、不计未读（清扫随 NC-S4）。 */
const retentionDays = 90

export interface UserNotificationItem {
  id: string
  kind: UserNotificationKind
  createdAt: string
  read: boolean
  /**
   * 接收人当前是否仍能看到通知对应的内容。为 false 时不返回任何名称与跳转目标，
   * 界面显示“该内容已不可见”（方案第 7 节：失权后不能经旧通知看到名称）。
   */
  visible: boolean
  actor: { id: string; name: string } | null
  workspace: { id: string; name: string } | null
  /** 对象名称：任务标题；@ 与被加入项目没有单独的对象名称。 */
  objectName: string | null
  target: { type: UserNotificationObjectType; id: string; sessionId: string | null } | null
}

export interface UserNotificationPage {
  items: UserNotificationItem[]
  nextCursor: string | null
}

interface NotificationRow {
  id: string
  kind: UserNotificationKind
  createdAtToken: string
  createdAt: Date
  readAt: Date | null
  visible: boolean
  actorUserId: string | null
  actorName: string | null
  workspaceId: string | null
  workspaceName: string | null
  objectType: UserNotificationObjectType
  objectId: string
  objectName: string | null
  sessionId: string | null
}

/**
 * 站内通知（方案 NC-S1）：本人的通知列表、未读数与已读。只读写接收人本人的记录；
 * 每次读取按接收人当前权限重新判断可见性并解析名称，通知本身不是授权依据。
 */
export class PostgresUserNotificationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async list(input: { userId: string; status?: string | null; cursor?: string | null; limit?: number }): Promise<UserNotificationPage> {
    const status = input.status ?? 'all'
    if (status !== 'all' && status !== 'unread') throw requestInvalid('status 必须为 all 或 unread')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw requestInvalid('limit 必须为 1 到 50 之间的整数')
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    const sql = this.database
    const rows = await sql<NotificationRow[]>`
      select n.id, n.kind, n.created_at::text as "createdAtToken", n.created_at as "createdAt", n.read_at as "readAt",
             v.visible, n.actor_user_id as "actorUserId", actor.display_name as "actorName",
             n.workspace_id as "workspaceId", w.name as "workspaceName",
             n.object_type as "objectType", n.object_id as "objectId", pt.title as "objectName",
             n.safe_metadata ->> 'sessionId' as "sessionId"
        from user_notifications n
        ${visibilityJoins(sql, input.userId)}
       where n.tenant_id = ${tenantId} and n.recipient_user_id = ${input.userId}
         and n.created_at > now() - make_interval(days => ${retentionDays})
         and ${status === 'unread' ? sql`n.read_at is null` : sql`true`}
         and ${cursor === null ? sql`true` : sql`(n.created_at, n.id) < ((${cursor.at}::text)::timestamptz, ${cursor.id})`}
       order by n.created_at desc, n.id desc
       limit ${limit + 1}
    `
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    return {
      items: page.map(toItem),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAtToken, last.id) : null,
    }
  }

  /**
   * 未读数：未读、仍可见、在保留期内的通知。按空间静音时该空间的通知不计（仍会列出），
   * @ 我不受静音影响（方案 NC5，与 D38 一致）。
   */
  async unreadCount(userId: string): Promise<{ unread: number }> {
    const sql = this.database
    const [row] = await sql<Array<{ unread: number }>>`
      select count(*)::integer as unread
        from user_notifications n
        ${visibilityJoins(sql, userId)}
        left join workspace_notification_states ns
          on ns.tenant_id = n.tenant_id and ns.workspace_id = n.workspace_id and ns.user_id = n.recipient_user_id
       where n.tenant_id = ${tenantId} and n.recipient_user_id = ${userId} and n.read_at is null
         and n.created_at > now() - make_interval(days => ${retentionDays})
         and v.visible
         and (n.kind = 'mention' or ns.muted_at is null)
    `
    return { unread: Number(row?.unread ?? 0) }
  }

  async markRead(userId: string, notificationId: string): Promise<{ id: string; read: true }> {
    const [row] = await this.database<Array<{ id: string }>>`
      update user_notifications set read_at = coalesce(read_at, now())
       where tenant_id = ${tenantId} and recipient_user_id = ${userId} and id = ${notificationId}
      returning id
    `
    if (!row) throw notFound('通知不存在')
    return { id: row.id, read: true }
  }

  async markAllRead(userId: string): Promise<{ read: number }> {
    const rows = await this.database<Array<{ id: string }>>`
      update user_notifications set read_at = now()
       where tenant_id = ${tenantId} and recipient_user_id = ${userId} and read_at is null
      returning id
    `
    return { read: rows.length }
  }
}

/**
 * 读取时的可见性：所在项目空间仍对本人可读（现任成员、账号有效）；任务未被删除；
 * @ 所在的会话仍有效。别名 `n` 是通知行，产出 `w`、`pt`、`actor` 与布尔列 `v.visible`。
 */
function visibilityJoins(sql: DatabaseClient, userId: string) {
  return sql`
    left join workspaces w on w.tenant_id = n.tenant_id and w.id = n.workspace_id
    left join project_tasks pt on n.object_type = 'project_task'
      and pt.tenant_id = n.tenant_id and pt.id = n.object_id and pt.workspace_id = n.workspace_id
      and pt.removed_at is null
    left join messages m on n.object_type = 'message' and m.tenant_id = n.tenant_id and m.id = n.object_id
    left join sessions s on s.tenant_id = m.tenant_id and s.id = m.session_id
      and s.workspace_id = n.workspace_id and s.status = 'active'
    left join users actor on actor.tenant_id = n.tenant_id and actor.id = n.actor_user_id
    cross join lateral (select (
      (n.workspace_id is null or (w.id is not null and (${readableWorkspacePredicate(sql, userId)})))
      and (n.object_type <> 'project_task' or pt.id is not null)
      and (n.object_type <> 'message' or s.id is not null)
    ) as visible) v
  `
}

function toItem(row: NotificationRow): UserNotificationItem {
  const base = { id: row.id, kind: row.kind, createdAt: row.createdAt.toISOString(), read: row.readAt !== null }
  if (!row.visible) return { ...base, visible: false, actor: null, workspace: null, objectName: null, target: null }
  return {
    ...base,
    visible: true,
    actor: row.actorUserId ? { id: row.actorUserId, name: row.actorName ?? '' } : null,
    workspace: row.workspaceId ? { id: row.workspaceId, name: row.workspaceName ?? '' } : null,
    objectName: row.objectName,
    target: { type: row.objectType, id: row.objectId, sessionId: row.sessionId },
  }
}

function encodeCursor(createdAtToken: string, id: string) {
  return Buffer.from(JSON.stringify({ at: createdAtToken, id }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    if (cursor.length > 512) throw new Error('length')
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(parsed.at) || parsed.at.length > 64
      || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 160) throw new Error('shape')
    return { at: parsed.at, id: parsed.id }
  } catch {
    throw requestInvalid('无效的分页游标')
  }
}
