import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { bumpTeamAuthRevision } from '../../authorization/postgres-workspace-grant-source-service.ts'

const tenantId = 'tenant-dsh-work'

export type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

export type RevocationEventKind = 'member_removed' | 'member_exit' | 'role_changed'

export interface MemberCandidate {
  id: string
  displayName: string
  department: string
}

export interface MemberCandidatePage {
  items: MemberCandidate[]
  nextCursor: string | null
}

export interface MemberRecord {
  userId: string
  displayName: string
  role: MemberRole
  joinedAt: string
}

const memberRoles: MemberRole[] = ['owner', 'admin', 'member', 'viewer']

/**
 * Team-workspace employee member management (1A-T3). Personal workspace
 * behavior is untouched: every public method re-asserts the team-only
 * boundary, and routes additionally reject personal workspaces before any
 * role check so team semantics never leak into personal spaces.
 */
export class PostgresWorkspaceMemberService {
  private readonly database: DatabaseClient
  private readonly authorization: PostgresAuthorizationService

  constructor(database: DatabaseClient, authorization: PostgresAuthorizationService) {
    this.database = database
    this.authorization = authorization
  }

  /**
   * Directory candidates searchable by name, ordered by (display_name, id) to
   * match the users_business_directory partial index. Only active business
   * employees with current workbench access are selectable (TW-01); existing
   * members are excluded.
   */
  async listMemberCandidates(
    workspaceId: string,
    input: { query?: string; cursor?: string; limit?: number },
  ): Promise<MemberCandidatePage> {
    await this.assertTeamWorkspace(workspaceId)
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const cursor = input.cursor ? decodeCandidateCursor(input.cursor) : null
    const pattern = input.query?.trim()
      ? `%${input.query.trim().replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
      : null

    const rows = await this.database<{
      id: string
      displayName: string
      department: string
    }[]>`
      select u.id, u.display_name as "displayName",
             coalesce(u.department_id, '未分配部门') as department
        from users u
       where u.tenant_id = ${tenantId}
         and u.status = 'active'
         and u.identity_provider = 'ai-hub'
         and u.business_user = true
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
         and exists (${this.database.unsafe(workbenchAccessPredicate)})
         and not exists (
           select 1 from workspace_members wm
            where wm.tenant_id = u.tenant_id
              and wm.workspace_id = ${workspaceId}
              and wm.user_id = u.id
         )
         and ${pattern === null
           ? this.database`true`
           : this.database`u.display_name ilike ${pattern} escape '\\'`}
         and ${cursor === null
           ? this.database`true`
           : this.database`(u.display_name > ${cursor.name} or (u.display_name = ${cursor.name} and u.id > ${cursor.id}))`}
       order by u.display_name asc, u.id asc
       limit ${limit + 1}
    `

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(({ id, displayName, department }) => ({
      id,
      displayName,
      department,
    }))
    const last = items[items.length - 1]
    return {
      items,
      nextCursor: hasMore && last ? encodeCandidateCursor(last.displayName, last.id) : null,
    }
  }

  /**
   * Adds an employee to the team workspace. Idempotent for identical roles;
   * a different role for an existing member is rejected so role changes stay
   * on the dedicated PATCH endpoint. Re-asserts the actor holds owner/admin
   * at service level so a demotion racing the route guard cannot slip in.
   */
  async addMember(
    workspaceId: string,
    targetUserId: string,
    role: MemberRole,
    actorUserId: string,
  ): Promise<{ member: MemberRecord; created: boolean }> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    await this.assertAddableEmployee(targetUserId)
    if (role === 'owner') throw new Error('负责人不能直接设置，请通过负责人转交功能')
    if (actorRole === 'admin' && role === 'admin') throw new Error('管理员没有权限任命管理员')

    // Existing-membership check runs outside the transaction: two concurrent
    // adds of the same employee can both pass it and both report
    // created: true (the insert below is on conflict do nothing). Benign —
    // the read-back after the transaction reflects the committed state, so
    // one caller may simply see the other's role.
    const existing = await this.findMemberRecord(workspaceId, targetUserId)
    if (existing) {
      if (existing.role === role) return { member: existing, created: false }
      throw new Error('该员工已是空间成员，不能直接变更角色，请使用角色调整功能')
    }

    await this.database.begin(async (transaction) => {
      await transaction`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${workspaceId}, ${targetUserId}, ${role}, ${actorUserId})
        on conflict (tenant_id, workspace_id, user_id) do nothing
      `
      await bumpTeamAuthRevision(transaction, workspaceId)
    })
    const member = await this.findMemberRecord(workspaceId, targetUserId)
    if (!member) throw new Error('成员添加失败，请稍后重试')
    return { member, created: true }
  }

  /**
   * Changes an existing member's role. The owner role is never assignable
   * here — owner changes go through the owner transfer endpoint (AC-02).
   * Re-asserts the actor holds owner/admin at service level so a demotion
   * racing the route guard cannot slip in; a concurrent owner transfer is
   * translated into a friendly conflict error by runMembershipMutation.
   */
  async changeMemberRole(
    workspaceId: string,
    targetUserId: string,
    role: MemberRole,
    actorUserId: string,
  ): Promise<MemberRecord> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    const member = await this.findMemberRecord(workspaceId, targetUserId)
    if (!member) throw new Error('目标成员不存在于该空间')
    this.assertRoleChangeAllowed(actorRole, member.role, role)
    if (member.role === role) return member

    await this.runMembershipMutation(async (transaction) => {
      await transaction`
        update workspace_members
           set member_role = ${role}
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
      `
      await this.writeRevocationEvent(transaction, workspaceId, targetUserId, 'role_changed', {
        from: member.role,
        to: role,
        by: actorUserId,
      })
      await bumpTeamAuthRevision(transaction, workspaceId)
    })
    const updated = await this.findMemberRecord(workspaceId, targetUserId)
    if (!updated) throw new Error('目标成员不存在于该空间')
    return updated
  }

  /**
   * Removes a member. Their shared contributions and authorship are kept —
   * only the membership row and the team authorization revision change.
   * Re-asserts the actor holds owner/admin at service level so a demotion
   * racing the route guard cannot slip in; a concurrent owner transfer is
   * translated into a friendly conflict error by runMembershipMutation.
   */
  async removeMember(
    workspaceId: string,
    targetUserId: string,
    actorUserId: string,
  ): Promise<{ userId: string; removed: true }> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(workspaceId, actorUserId, ['owner', 'admin'])
    const targetRole = await this.memberRoleOf(workspaceId, targetUserId)
    if (!targetRole) throw new Error('目标成员不存在于该空间')
    if (targetRole === 'owner') {
      if (actorRole === 'admin') throw new Error('管理员没有权限移除管理员或负责人')
      // Pre-check replaces the deferred single-owner trigger failure with a
      // friendly message (the trigger would roll the delete back anyway).
      throw new Error('负责人不能直接移除，请先转交负责人')
    }
    if (actorRole === 'admin' && targetRole === 'admin') {
      throw new Error('管理员没有权限移除管理员或负责人')
    }

    await this.runMembershipMutation(async (transaction) => {
      await transaction`
        delete from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${targetUserId}
      `
      await this.writeRevocationEvent(transaction, workspaceId, targetUserId, 'member_removed', {
        by: actorUserId,
      })
      await bumpTeamAuthRevision(transaction, workspaceId)
    })
    return { userId: targetUserId, removed: true }
  }

  /**
   * Self exit for any non-owner member. The owner must transfer first.
   * Re-asserts membership at service level; a concurrent owner transfer
   * (actor becomes owner mid-request) is translated into a friendly
   * conflict error by runMembershipMutation.
   */
  async exitWorkspace(
    workspaceId: string,
    actorUserId: string,
  ): Promise<{ workspaceId: string; exited: true }> {
    await this.assertTeamWorkspace(workspaceId)
    const actorRole = await this.requireActorRole(
      workspaceId,
      actorUserId,
      ['owner', 'admin', 'member', 'viewer'],
    )
    if (actorRole === 'owner') throw new Error('负责人不能直接退出空间，请先转交负责人')

    await this.runMembershipMutation(async (transaction) => {
      await transaction`
        delete from workspace_members
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${actorUserId}
      `
      await this.writeRevocationEvent(transaction, workspaceId, actorUserId, 'member_exit', {
        by: actorUserId,
      })
      await bumpTeamAuthRevision(transaction, workspaceId)
    })
    return { workspaceId, exited: true }
  }

  /**
   * Owner transfer: locks the workspace row so concurrent transfers serialize
   * (AC-02), swaps the two membership roles, bumps the revision and records
   * one role_changed event per affected user. Content creator fields are
   * never touched. The actor is fully re-verified against the current owner;
   * the deferred single-owner trigger validates the swap at commit and a
   * concurrent loser's trigger failure is translated to a friendly conflict
   * error by runMembershipMutation.
   */
  async transferWorkspaceOwner(
    workspaceId: string,
    toUserId: string,
    actorUserId: string,
  ): Promise<{ workspaceId: string; previousOwnerId: string; newOwnerId: string }> {
    await this.assertTeamWorkspace(workspaceId)
    const previousOwnerId = await this.authorization.resolveWorkspaceOwner(workspaceId)
    if (previousOwnerId !== actorUserId) throw new Error('没有权限转交负责人')
    if (toUserId === previousOwnerId) throw new Error('转交目标不能是当前负责人')
    const targetRole = await this.memberRoleOf(workspaceId, toUserId)
    if (!targetRole) throw new Error('转交目标必须是该空间的现有成员')

    await this.runMembershipMutation(async (transaction) => {
      // Serialize owner transfers per workspace: a second concurrent
      // transfer blocks here until the first commits, then fails the
      // single-owner trigger at commit time.
      await transaction`
        select id from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
         for update
      `
      await transaction`
        update workspace_members
           set member_role = 'member'
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${previousOwnerId}
      `
      await transaction`
        update workspace_members
           set member_role = 'owner'
         where tenant_id = ${tenantId}
           and workspace_id = ${workspaceId}
           and user_id = ${toUserId}
      `
      await this.writeRevocationEvent(transaction, workspaceId, previousOwnerId, 'role_changed', {
        from: 'owner',
        to: 'member',
        by: actorUserId,
      })
      await this.writeRevocationEvent(transaction, workspaceId, toUserId, 'role_changed', {
        from: targetRole,
        to: 'owner',
        by: actorUserId,
      })
      await bumpTeamAuthRevision(transaction, workspaceId)
    })
    return { workspaceId, previousOwnerId, newOwnerId: toUserId }
  }

  // -------------------------------------------------------------------------
  // Shared checks
  // -------------------------------------------------------------------------

  private async assertTeamWorkspace(workspaceId: string) {
    const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
      select workspace_type as type from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId} and status = 'active'
    `
    if (!workspace) throw new Error('工作空间不存在或已归档')
    if (workspace.type !== 'team') throw new Error('仅支持团队工作空间进行成员管理')
  }

  /**
   * Rejects employees outside the addable directory (TW-01): active business
   * employees with current workbench access, same criterion requireIdentity
   * applies for the workbench:use permission.
   */
  private async assertAddableEmployee(userId: string) {
    const [row] = await this.database<{ reason: string | null }[]>`
      select case
        when u.status <> 'active' then 'disabled'
        when u.identity_provider <> 'ai-hub' or not u.business_user then 'directory'
        when not exists (${this.database.unsafe(workbenchAccessPredicate)}) then 'no_access'
        else null
      end as reason
        from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId}
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
    `
    if (!row) throw new Error('目标员工不存在')
    if (row.reason === 'disabled') throw new Error('该员工已停用，不能添加为成员')
    if (row.reason === 'directory') throw new Error('该员工不属于业务员工目录，不能添加为成员')
    if (row.reason === 'no_access') throw new Error('该员工不具备员工工作台使用权限，不能添加为成员')
  }

  private async memberRoleOf(workspaceId: string, userId: string): Promise<MemberRole | null> {
    const [member] = await this.database<{ role: MemberRole }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId}
         and workspace_id = ${workspaceId}
         and user_id = ${userId}
    `
    return member?.role ?? null
  }

  /**
   * Service-level re-verification of the actor's current role. Route guards
   * run before this read, so a demotion racing in between (TOCTOU) must be
   * caught here: the actor must be a member and hold one of `allowedRoles`,
   * otherwise a permission denial is thrown.
   */
  private async requireActorRole(
    workspaceId: string,
    actorUserId: string,
    allowedRoles: MemberRole[],
  ): Promise<MemberRole> {
    const role = await this.memberRoleOf(workspaceId, actorUserId)
    if (!role) throw new Error('当前用户不是该空间的成员')
    if (!allowedRoles.includes(role)) throw new Error('当前用户角色没有权限执行此操作')
    return role
  }

  private assertRoleChangeAllowed(actorRole: MemberRole, targetRole: MemberRole, newRole: MemberRole) {
    if (targetRole === 'owner') throw new Error('没有权限调整负责人的角色，请使用负责人转交功能')
    if (newRole === 'owner') throw new Error('负责人不能直接设置，请通过负责人转交功能')
    if (actorRole === 'admin') {
      if (targetRole === 'admin') throw new Error('管理员没有权限调整管理员的角色')
      if (newRole === 'admin') throw new Error('管理员没有权限任命管理员')
    }
  }

  private async findMemberRecord(workspaceId: string, userId: string): Promise<MemberRecord | null> {
    const [member] = await this.database<{
      userId: string
      displayName: string
      role: MemberRole
      joinedAt: Date
    }[]>`
      select wm.user_id as "userId", u.display_name as "displayName",
             wm.member_role as role, wm.joined_at as "joinedAt"
        from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
       where wm.tenant_id = ${tenantId}
         and wm.workspace_id = ${workspaceId}
         and wm.user_id = ${userId}
    `
    if (!member) return null
    return {
      userId: member.userId,
      displayName: member.displayName,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    }
  }

  /**
   * Runs a membership mutation in a transaction and translates the deferred
   * single-owner trigger failure (team_workspace_single_owner, migration
   * 0022 — raise text "must have exactly one owner") into a friendly
   * conflict error. The trigger can only abort here when a concurrent owner
   * transfer committed between the role pre-checks (which run outside the
   * transaction) and the mutation, so the error instructs a refresh instead
   * of surfacing the raw trigger message as a 500.
   */
  private async runMembershipMutation(
    action: (transaction: DatabaseTransaction) => Promise<void>,
  ): Promise<void> {
    try {
      await this.database.begin(async (transaction) => {
        await action(transaction)
      })
    } catch (error) {
      if (isSingleOwnerViolation(error)) {
        throw new Error('负责人信息已变化，不能继续操作，请刷新后重试')
      }
      throw error
    }
  }

  private async writeRevocationEvent(
    transaction: DatabaseTransaction,
    workspaceId: string,
    userId: string,
    kind: RevocationEventKind,
    payload: Record<string, string>,
  ) {
    // payload_hash is md5(payload::text) computed by the database so replays
    // with logically identical payloads always produce the same hash and hit
    // the workspace_revocation_events_dedupe unique key.
    await transaction`
      insert into workspace_revocation_events (
        id, tenant_id, workspace_id, user_id, kind, payload, payload_hash
      ) values (
        ${`wrev-${randomUUID()}`}, ${tenantId}, ${workspaceId}, ${userId}, ${kind},
        ${transaction.json(payload)}, md5(${transaction.json(payload)}::text)
      )
      on conflict do nothing
    `
  }
}

const workbenchAccessPredicate = /* sql */ `
  select 1
    from user_roles ur
    join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
   where ur.tenant_id = u.tenant_id and ur.user_id = u.id
     and ur.source_key = 'local'
     and (ur.valid_until is null or ur.valid_until > now())
     and r.status = 'active'
     and r.permissions ? 'workbench:use'
`

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && memberRoles.includes(value as MemberRole)
}

function encodeCandidateCursor(displayName: string, id: string) {
  return Buffer.from(JSON.stringify({ n: displayName, i: id }), 'utf8').toString('base64url')
}

function decodeCandidateCursor(cursor: string): { name: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { n?: unknown; i?: unknown }
    if (typeof parsed.n !== 'string' || typeof parsed.i !== 'string') throw new Error('bad cursor')
    return { name: parsed.n, id: parsed.i }
  } catch {
    throw new Error('分页游标无效')
  }
}

function isSingleOwnerViolation(error: unknown) {
  return error instanceof Error && /exactly one owner/.test(error.message)
}
