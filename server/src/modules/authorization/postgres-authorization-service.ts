import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { redactSensitiveText } from '../../security/safe-observability.ts'

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

export class PostgresAuthorizationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
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
