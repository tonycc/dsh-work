import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { redactSensitiveText } from '../../security/safe-observability.ts'
import { authorizationDenied } from './authorization-errors.ts'

const tenantId = 'tenant-dsh-work'

interface IdentityRow {
  id: string
  roleIds: string[]
  permissions: string[]
}

interface AgentAuthorizationRow {
  versionId: string
  skillReferences: string[]
  toolReferences: string[]
  visibleRoleIds: string[]
  dataScopes: string[]
}

interface CapabilityVersion {
  reference: string
  versionId: string
  toolReferences?: string[]
}

export interface RuntimeAuthorizationDecision {
  userId: string
  workspaceId: string | null
  roleIds: string[]
  permissions: string[]
  dataScopes: string[]
  agentVersionId: string
}

export interface SessionAuthorizationContext {
  roleIds: string[]
  dataScopes: string[]
}

export type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/** Stream-access cache stays well under these bounds; both are safety caps. */
const STREAM_ACCESS_CACHE_SWEEP_THRESHOLD = 512
const STREAM_ACCESS_CACHE_MAX_ENTRIES = 4_096

export class PostgresAuthorizationService {
  private readonly database: DatabaseClient
  private readonly streamAccessTtlMs: number
  /**
   * In-process read-access cache for team-workspace SSE delivery (1A-T5,
   * confirmed decision: in-process cache + revision invalidation, see
   * docs/product/team-workspace-batch-1a-convergence.md §4). Entries are
   * keyed by workspace+viewer and hold the workspace's team_auth_revision at
   * check time: a revision change invalidates immediately, otherwise the
   * cached grant is trusted for a short TTL so the 250ms SSE poll does not
   * re-run full authorization on every batch.
   */
  private readonly teamReadAccessCache = new Map<string, { revision: number; checkedAt: number }>()

  constructor(database: DatabaseClient, streamAccessTtlMs = 10_000) {
    this.database = database
    this.streamAccessTtlMs = streamAccessTtlMs
  }

  async authorizeWorkbench(input: {
    userId: string
    workspaceId?: string | null
    roleIds?: string[]
    dataScopes?: string[]
  }) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    try {
      const identity = await this.requireIdentity(input.userId, input.roleIds)
      if (!identity.permissions.includes('workbench:use')) {
        throw new Error('当前用户没有员工工作台使用权限')
      }
      const workspaceType = workspaceId
        ? await this.requireWorkspaceMembership(input.userId, workspaceId)
        : null
      const dataScopes = await this.resolveDataScopes(identity, workspaceId, input.dataScopes)
      return { ...identity, workspaceId, workspaceType, dataScopes }
    } catch (error) {
      await this.recordDecision(input.userId, workspaceId ?? 'standalone', 'authorization.workbench', 'blocked', error)
      throw error
    }
  }

  async authorizeRuntime(input: {
    userId: string
    workspaceId?: string | null
    agentVersionId: string
    roleIds?: string[]
    dataScopes?: string[]
    additionalSkillReferences?: string[]
  }): Promise<RuntimeAuthorizationDecision> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    try {
      const context = await this.authorizeWorkbench({
        userId: input.userId,
        workspaceId,
        roleIds: input.roleIds,
        dataScopes: input.dataScopes,
      })
      const { agent, skillVersions } = await this.assertAgentDependencyClosure(
        input.agentVersionId,
        input.additionalSkillReferences ?? [],
      )
      if (!intersects(context.roleIds, agent.visibleRoleIds)) {
        throw new Error('当前用户角色不可使用所选 Agent')
      }
      requireScopes(context.dataScopes, agent.dataScopes, 'Agent')

      const toolVersions = await this.resolveAndAuthorizeTools(
        agent.toolReferences,
        context.roleIds,
        context.dataScopes,
      )
      if (workspaceId && context.workspaceType === 'team') {
        await this.requireWorkspaceCapabilities(workspaceId, 'agent', [{
          reference: input.agentVersionId,
          versionId: input.agentVersionId,
        }])
        await this.requireWorkspaceCapabilities(workspaceId, 'skill', skillVersions)
        await this.requireWorkspaceCapabilities(workspaceId, 'tool', toolVersions)
      }

      await this.recordDecision(input.userId, input.agentVersionId, 'authorization.runtime', 'success')
      return {
        userId: input.userId,
        workspaceId,
        roleIds: context.roleIds,
        permissions: context.permissions,
        dataScopes: context.dataScopes,
        agentVersionId: input.agentVersionId,
      }
    } catch (error) {
      await this.recordDecision(input.userId, input.agentVersionId, 'authorization.runtime', 'blocked', error)
      throw error
    }
  }

  /**
   * Execution-time re-check for team-workspace runs (1A-T5): the same
   * closure as authorizeRuntime plus the team role predicate — a viewer
   * (只读成员) cannot run or continue runs (plan §5 权限矩阵), so a demotion
   * must stop in-flight execution. Personal/standalone callers must skip this
   * method entirely and keep the existing path (AC-23).
   */
  async authorizeTeamRunExecution(input: {
    userId: string
    workspaceId: string
    agentVersionId: string
    roleIds?: string[]
    dataScopes?: string[]
    additionalSkillReferences?: string[]
  }): Promise<RuntimeAuthorizationDecision> {
    const decision = await this.authorizeRuntime(input)
    const [member] = await this.database<{ role: TeamMemberRole }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${input.workspaceId}
         and user_id = ${input.userId}
    `
    if (!member) throw new Error('当前用户已不是该团队空间成员')
    if (member.role === 'viewer') throw new Error('当前用户角色为只读，不能继续执行任务')

    // Agent 关联状态必须与能力授权分开校验：对账把 legacy 来源改写为 manual 后，
    // 停用 Agent 成员不会删除该 grant，仅靠 requireWorkspaceCapabilities 会放行已
    // 停用/移出的关联，导致既有会话继续续写或重试。
    //
    // 必须通过「版本所属 Agent」定位成员，而不是按成员的当前 agent_version_id 匹配：
    // Agent 从 v1 升级到 v2 后成员行指向 v2，v1 会话会查不到关联而被误当作历史无关联
    // 场景放行。升级后旧版本是否仍可执行由成员状态决定（1A 保留旧版本授权）。
    const [agentMember] = await this.database<{ status: string }[]>`
      select wam.status
        from workspace_agent_members wam
        join agent_versions av
          on av.tenant_id = wam.tenant_id and av.id = ${input.agentVersionId}
       where wam.tenant_id = ${tenantId} and wam.workspace_id = ${input.workspaceId}
         and wam.agent_id = av.agent_id
       order by case when wam.status = 'available' then 0 else 1 end, wam.created_at asc
       limit 1
    `
    if (agentMember && agentMember.status !== 'available') {
      throw authorizationDenied('Agent 成员已停用或已移出该团队空间，不能继续执行任务')
    }
    return decision
  }

  /**
   * Read-only workspace type lookup that does NOT depend on the caller's
   * current membership (unlike resolveWorkspaceType): the execution-time
   * re-check must decide "is this a team workspace" even after the requesting
   * user has already been removed.
   */
  async workspaceTypeOf(workspaceId: string | null | undefined): Promise<'personal' | 'team' | null> {
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return null
    const [row] = await this.database<{ type: 'personal' | 'team' }[]>`
      select w.workspace_type as type from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${id} and w.status = 'active'
    `
    return row?.type ?? null
  }

  /**
   * Per-batch read-access verification for team-workspace SSE streams
   * (1A-T5): reads the workspace's team_auth_revision and only re-runs full
   * authorization on a cache miss, a revision change (immediate invalidation)
   * or TTL expiry. Throws when the viewer no longer has read access so the
   * stream can terminate before delivering the batch.
   */
  async authorizeTeamReadAccess(workspaceId: string, userId: string, ttlMs = this.streamAccessTtlMs) {
    const [row] = await this.database<{ revision: number }[]>`
      select team_auth_revision as revision from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
    `
    if (!row) throw new Error('工作空间不存在或已归档')
    // Key includes tenant so a future multi-tenant deployment cannot mix entries.
    const key = `${tenantId}:${workspaceId}:${userId}`
    const cached = this.teamReadAccessCache.get(key)
    if (cached && cached.revision === row.revision && Date.now() - cached.checkedAt < ttlMs) return
    await this.authorizeWorkbench({ userId, workspaceId })
    this.setStreamAccessCache(key, { revision: row.revision, checkedAt: Date.now() }, ttlMs)
  }

  /**
   * Bounds the in-process stream-access cache. Entries expire by TTL but were
   * never evicted, so a long-lived process accumulated one entry per
   * (tenant, workspace, viewer) pair forever. Sweep expired entries once the
   * map grows past a threshold and hard-cap the size as a backstop; the cache
   * is only a latency optimization, so dropping entries is always safe.
   */
  private setStreamAccessCache(key: string, entry: { revision: number; checkedAt: number }, ttlMs: number) {
    if (this.teamReadAccessCache.size >= STREAM_ACCESS_CACHE_SWEEP_THRESHOLD) {
      const now = Date.now()
      for (const [existingKey, existing] of this.teamReadAccessCache) {
        if (now - existing.checkedAt >= ttlMs) this.teamReadAccessCache.delete(existingKey)
      }
      if (this.teamReadAccessCache.size >= STREAM_ACCESS_CACHE_MAX_ENTRIES) {
        const oldest = this.teamReadAccessCache.keys().next()
        if (!oldest.done) this.teamReadAccessCache.delete(oldest.value)
      }
    }
    this.teamReadAccessCache.set(key, entry)
  }

  /**
   * Re-checks the agent version's role visibility at write time (1A-T4): the
   * candidate picker filters by visible_role_ids, but a caller can submit an
   * agent id directly, so the add path must not rely on the picker for
   * authorization. Mirrors the authorizeRuntime check.
   */
  async assertAgentVersionVisibleToRoles(agentVersionId: string, roleIds: string[], label = '所选 Agent') {
    const agent = await this.requireAgentVersion(agentVersionId)
    if (!intersects(roleIds, agent.visibleRoleIds)) {
      throw authorizationDenied(`当前用户角色不可使用${label}`)
    }
    return agent
  }

  /**
   * Structural dependency validation shared by runtime authorization and the
   * team agent-member join/upgrade/enable flows (1A-T4): the agent version
   * must be published and must explicitly authorize every tool its selected
   * skills require — skills cannot widen the agent's tool allowlist. Returns
   * the loaded agent version and the resolved skill versions so callers can
   * build capability grant sources without duplicating the resolution logic.
   */
  async assertAgentDependencyClosure(
    agentVersionId: string,
    additionalSkillReferences: string[] = [],
  ): Promise<{ agent: AgentAuthorizationRow; skillVersions: CapabilityVersion[] }> {
    const agent = await this.requireAgentVersion(agentVersionId)
    const skillVersions = await this.resolveSkillVersions(
      mergeSkillReferences(agent.skillReferences, additionalSkillReferences),
    )
    const authorizedToolReferences = new Set(unique(agent.toolReferences))
    const missingSkillTools = unique(skillVersions.flatMap(skill => skill.toolReferences ?? []))
      .filter(reference => !authorizedToolReferences.has(reference))
    if (missingSkillTools.length) {
      throw new Error(`Agent 必须显式授权所选 Skill 依赖的工具：${missingSkillTools.join('、')}`)
    }
    return { agent, skillVersions }
  }

  /**
   * Resolves tool references to published tool version IDs with the same
   * availability checks as runtime authorization but without role or data
   * scope checks: used by the team agent-member join flow (1A-T4) to build
   * grant sources. Runtime calls keep the full role/scope checks via
   * resolveAndAuthorizeTools.
   */
  async resolveToolVersions(references: string[]): Promise<CapabilityVersion[]> {
    const rows = await this.resolveToolVersionRows(references)
    return rows.map(row => ({ reference: row.reference, versionId: row.versionId }))
  }

  /**
   * Read-only workspace type lookup for team-branch routing (1A-T4 session
   * start). Returns 'team' only when the user is a member of that team
   * workspace, so non-members and personal-space edge cases keep the exact
   * existing conversation-path behavior; personal owners get 'personal' and
   * everything else falls through as null.
   */
  async resolveWorkspaceType(
    workspaceId: string | null | undefined,
    userId: string,
  ): Promise<'personal' | 'team' | null> {
    const id = normalizeWorkspaceId(workspaceId)
    if (!id) return null
    const [row] = await this.database<{ type: 'personal' | 'team' }[]>`
      select w.workspace_type as type from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${id} and w.status = 'active'
         and (
           (w.workspace_type = 'personal' and w.created_by = ${userId})
           or (
             w.workspace_type = 'team'
             and exists (
               select 1 from workspace_members wm
                where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                  and wm.user_id = ${userId}
             )
           )
         )
    `
    return row?.type ?? null
  }

  async requirePlatformAdmin(userId: string) {
    const [row] = await this.database<{ id: string; displayName: string; department: string }[]>`
      select u.id, u.display_name as "displayName",
             coalesce(u.department_id, '未分配部门') as department
        from users u
       where u.tenant_id = ${tenantId} and u.id = ${userId}
         and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and ur.source_key = 'local' and r.status = 'active'
              and (ur.valid_until is null or ur.valid_until > now())
              and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
         )
    `
    if (!row) throw new Error(`操作人不存在、已停用或不是平台管理员：${userId}`)
    return row
  }

  /**
   * Building block, not a complete identity check: verifies only that the
   * given user holds one of `allowedRoles` in the given team workspace.
   * Callers must compose it with `authorizeWorkbench` (or an equivalent
   * identity check) to satisfy the 员工有效身份 requirement — this method
   * does not verify the user exists or is an active employee. Personal
   * workspaces are intentionally a no-op (team role checks do not apply).
   */
  async requireTeamRole(
    workspaceId: string,
    userId: string,
    allowedRoles: TeamMemberRole[],
  ) {
    const [workspace] = await this.database<{ type: 'personal' | 'team' }[]>`
      select w.workspace_type as type from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId} and w.status = 'active'
    `
    if (!workspace) throw new Error('工作空间不存在、已归档或当前用户不是成员')
    if (workspace.type === 'personal') return
    const [member] = await this.database<{ role: TeamMemberRole }[]>`
      select wm.member_role as role from workspace_members wm
       where wm.tenant_id = ${tenantId} and wm.workspace_id = ${workspaceId}
         and wm.user_id = ${userId}
    `
    if (!member) throw new Error('工作空间不存在、已归档或当前用户不是成员')
    if (!allowedRoles.includes(member.role)) {
      throw new Error(`当前用户角色无权执行此操作（允许角色：${allowedRoles.join('、')}）`)
    }
  }

  async resolveWorkspaceOwner(workspaceId: string) {
    const rows = await this.database<{ userId: string }[]>`
      select wm.user_id as "userId" from workspace_members wm
       where wm.tenant_id = ${tenantId} and wm.workspace_id = ${workspaceId}
         and wm.member_role = 'owner'
    `
    if (rows.length !== 1) {
      throw new Error(`工作空间负责人异常：需要且仅需要一名负责人，当前有 ${rows.length} 名`)
    }
    return rows[0].userId
  }

  private async requireIdentity(userId: string, sessionRoleIds?: string[]): Promise<IdentityRow> {
    if (sessionRoleIds !== undefined) {
      const [user] = await this.database<{ id: string }[]>`
        select u.id from users u
         where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
           and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
      `
      if (!user) throw new Error('当前用户不存在、已停用或所属企业不可用')
      const requestedRoleIds = unique(sessionRoleIds)
      if (requestedRoleIds.length === 0) return { id: user.id, roleIds: [], permissions: [] }
      const rows = await this.database<{ id: string; permissions: string[] }[]>`
        select r.id,
               coalesce(array_agg(distinct permission.value) filter (where permission.value is not null), '{}') as permissions
          from user_roles ur
          join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
         where ur.tenant_id = ${tenantId} and ur.user_id = ${userId}
           and ur.source_key = 'local'
           and (ur.valid_until is null or ur.valid_until > now())
           and r.status = 'active' and r.id in ${this.database(requestedRoleIds)}
         group by r.id
      `
      return {
        id: user.id,
        roleIds: rows.map(row => row.id),
        permissions: unique(rows.flatMap(row => row.permissions)),
      }
    }
    const [row] = await this.database<{ id: string; roleIds: string[]; permissions: string[] }[]>`
      select u.id,
             coalesce(jsonb_agg(distinct r.id) filter (where r.id is not null), '[]') as "roleIds",
             coalesce(jsonb_agg(distinct permission.value) filter (where permission.value is not null), '[]') as permissions
        from users u
        left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
          and (ur.valid_until is null or ur.valid_until > now())
          and ur.source_key = 'local'
        left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
          and r.status = 'active'
        left join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value) on true
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and exists (select 1 from tenants t where t.id = u.tenant_id and t.status = 'active')
       group by u.id
    `
    if (!row) throw new Error('当前用户不存在、已停用或所属企业不可用')
    return row
  }

  private async requireWorkspaceMembership(userId: string, workspaceId: string) {
    const [row] = await this.database<{ id: string; type: 'personal' | 'team' }[]>`
      select w.id, w.workspace_type as type from workspaces w
       where w.tenant_id = ${tenantId} and w.id = ${workspaceId} and w.status = 'active'
         and (
           (w.workspace_type = 'personal' and w.created_by = ${userId})
           or (
             w.workspace_type = 'team'
             and exists (
               select 1 from workspace_members wm
                where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                  and wm.user_id = ${userId}
             )
           )
         )
    `
    if (!row) throw new Error('工作空间不存在、已归档或当前用户不是成员')
    return row.type
  }

  private async resolveDataScopes(
    identity: IdentityRow,
    workspaceId: string | null,
    sessionDataScopes?: string[],
  ) {
    const roleIds = identity.roleIds.length > 0 ? identity.roleIds : ['__no_role__']
    const grants = await this.database<{ scopeValue: string }[]>`
      select distinct scope_value as "scopeValue" from data_scope_grants
       where tenant_id = ${tenantId}
         and (
           (${sessionDataScopes === undefined} and subject_type = 'user' and subject_id = ${identity.id})
           or (subject_type = 'role' and subject_id in ${this.database(roleIds)})
           or (${workspaceId ?? ''} <> '' and subject_type = 'workspace' and subject_id = ${workspaceId ?? ''})
         )
       order by scope_value
    `
    return unique([
      ...(sessionDataScopes ?? []),
      ...grants.map(grant => grant.scopeValue),
    ]).sort()
  }

  private async requireAgentVersion(versionId: string): Promise<AgentAuthorizationRow> {
    const [row] = await this.database<AgentAuthorizationRow[]>`
      select av.id as "versionId", av.skill_refs as "skillReferences",
             av.tool_refs as "toolReferences", av.visible_role_ids as "visibleRoleIds",
             av.data_scopes as "dataScopes"
        from agent_versions av
        join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
       where av.tenant_id = ${tenantId} and av.id = ${versionId}
         and av.status = 'published' and a.status = 'published'
    `
    if (!row) throw new Error('Agent Version 不存在、未发布或所属 Agent 已停用')
    return row
  }

  private async resolveSkillVersions(references: string[]): Promise<CapabilityVersion[]> {
    const resolved: CapabilityVersion[] = []
    for (const reference of unique(references)) {
      const { id, version } = parseReference(reference, 'Skill')
      const [row] = await this.database<{ versionId: string; toolReferences: string[] }[]>`
        select sv.id as "versionId", sv.tool_refs as "toolReferences" from skills s
        join skill_versions sv on sv.tenant_id = s.tenant_id and sv.skill_id = s.id
         where s.tenant_id = ${tenantId} and s.id = ${id} and sv.version = ${version}
           and s.status = 'published' and sv.status = 'published'
      `
      if (!row) throw new Error(`Skill 不存在、未发布或已停用：${reference}`)
      resolved.push({ reference, versionId: row.versionId, toolReferences: row.toolReferences })
    }
    return resolved
  }

  private async resolveAndAuthorizeTools(
    references: string[],
    roleIds: string[],
    dataScopes: string[],
  ): Promise<CapabilityVersion[]> {
    const resolved = await this.resolveToolVersionRows(references)
    for (const tool of resolved) {
      if (!intersects(roleIds, tool.allowedRoleIds)) throw new Error(`当前用户角色不可调用工具：${tool.reference}`)
      requireScopes(dataScopes, tool.requiredDataScopes, `工具 ${tool.reference}`)
    }
    return resolved.map(tool => ({ reference: tool.reference, versionId: tool.versionId }))
  }

  private async resolveToolVersionRows(
    references: string[],
  ): Promise<Array<CapabilityVersion & { allowedRoleIds: string[]; requiredDataScopes: string[] }>> {
    const resolved: Array<CapabilityVersion & { allowedRoleIds: string[]; requiredDataScopes: string[] }> = []
    for (const reference of unique(references)) {
      const { id, version } = parseReference(reference, '工具')
      const [row] = await this.database<{
        versionId: string
        allowedRoleIds: string[]
        requiredDataScopes: string[]
      }[]>`
        select tv.id as "versionId", t.allowed_role_ids as "allowedRoleIds",
               t.data_scopes as "requiredDataScopes"
          from tools t
          join tool_versions tv on tv.tenant_id = t.tenant_id and tv.tool_id = t.id
          join connectors c on c.tenant_id = t.tenant_id and c.id = t.connector_id
         where t.tenant_id = ${tenantId} and t.id = ${id} and tv.version = ${version}
           and t.status = 'available' and t.mode = 'read'
           and tv.status = 'published' and c.status = 'healthy'
      `
      if (!row) throw new Error(`工具不存在、未发布、不可用或不符合一期只读策略：${reference}`)
      resolved.push({ reference, versionId: row.versionId, allowedRoleIds: row.allowedRoleIds, requiredDataScopes: row.requiredDataScopes })
    }
    return resolved
  }

  private async requireWorkspaceCapabilities(
    workspaceId: string,
    capabilityType: 'agent' | 'skill' | 'tool',
    capabilities: CapabilityVersion[],
  ) {
    if (capabilities.length === 0) return
    const rows = await this.database<{ capabilityVersionId: string }[]>`
      select capability_version_id as "capabilityVersionId"
        from workspace_capability_grants
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and capability_type = ${capabilityType}
    `
    if (rows.length === 0) {
      throw new Error(`工作空间未配置${capabilityLabel(capabilityType)}授权`)
    }
    const allowed = new Set(rows.map(row => row.capabilityVersionId))
    const denied = capabilities.filter(capability => !allowed.has(capability.versionId))
    if (denied.length) {
      throw new Error(`工作空间未授权${capabilityLabel(capabilityType)}：${denied.map(item => item.reference).join('、')}`)
    }
  }

  private async recordDecision(
    actorId: string,
    objectId: string,
    action: string,
    result: 'success' | 'blocked',
    error?: unknown,
  ) {
    const detail = error instanceof Error ? error.message : error ? String(error) : '授权通过'
    await this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type, object_id,
        result, trace_id, safe_context
      ) values (
        ${`audit-authorization-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, ${action},
        'authorization', ${objectId}, ${result}, ${`trace-authorization-${randomUUID()}`},
        ${this.database.json({ detail: redactSensitiveText(detail) })}
      )
    `
  }
}

function normalizeWorkspaceId(workspaceId: string | null | undefined) {
  return workspaceId && workspaceId !== 'standalone' ? workspaceId : null
}

function parseReference(reference: string, label: string) {
  const separator = reference.lastIndexOf('@')
  if (separator <= 0 || separator === reference.length - 1) {
    throw new Error(`${label}引用必须锁定版本：${reference}`)
  }
  return { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
}

function requireScopes(available: string[], required: string[], label: string) {
  const availableSet = new Set(available)
  const missing = unique(required).filter(scope => !availableSet.has(scope))
  if (missing.length) throw new Error(`${label}要求未授权的数据范围：${missing.join('、')}`)
}

function intersects(left: string[], right: string[]) {
  const rightSet = new Set(right)
  return left.some(value => rightSet.has(value))
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function mergeSkillReferences(base: string[], additional: string[]) {
  const references = new Map<string, string>()
  for (const reference of [...base, ...additional]) {
    const normalized = reference.trim()
    const { id } = parseReference(normalized, 'Skill')
    references.set(id, normalized)
  }
  return [...references.values()]
}

function capabilityLabel(type: 'agent' | 'skill' | 'tool') {
  if (type === 'agent') return 'Agent'
  if (type === 'skill') return 'Skill'
  return '工具'
}
