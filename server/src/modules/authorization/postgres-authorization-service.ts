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
}

export interface RuntimeAuthorizationDecision {
  userId: string
  workspaceId: string | null
  roleIds: string[]
  permissions: string[]
  dataScopes: string[]
  agentVersionId: string
}

export class PostgresAuthorizationService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async authorizeWorkbench(input: { userId: string; workspaceId?: string | null }) {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    try {
      const identity = await this.requireIdentity(input.userId)
      if (!identity.permissions.includes('workbench:use')) {
        throw new Error('当前用户没有员工工作台使用权限')
      }
      const workspaceType = workspaceId
        ? await this.requireWorkspaceMembership(input.userId, workspaceId)
        : null
      const dataScopes = await this.resolveDataScopes(identity, workspaceId)
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
  }): Promise<RuntimeAuthorizationDecision> {
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    try {
      const context = await this.authorizeWorkbench({ userId: input.userId, workspaceId })
      const agent = await this.requireAgentVersion(input.agentVersionId)
      if (!intersects(context.roleIds, agent.visibleRoleIds)) {
        throw new Error('当前用户角色不可使用所选 Agent')
      }
      requireScopes(context.dataScopes, agent.dataScopes, 'Agent')

      const skillVersions = await this.resolveSkillVersions(agent.skillReferences)
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

  async requirePlatformAdmin(displayName: string) {
    const [row] = await this.database<{ id: string; displayName: string; department: string }[]>`
      select u.id, u.display_name as "displayName",
             coalesce(u.department_id, '未分配部门') as department
        from users u
       where u.tenant_id = ${tenantId} and u.display_name = ${displayName.trim()}
         and u.status = 'active'
         and exists (
           select 1 from user_roles ur
           join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where ur.tenant_id = u.tenant_id and ur.user_id = u.id
              and (ur.valid_until is null or ur.valid_until > now())
              and r.permissions ? 'admin:*'
         )
    `
    if (!row) throw new Error(`操作人不存在、已停用或不是平台管理员：${displayName}`)
    return row
  }

  private async requireIdentity(userId: string): Promise<IdentityRow> {
    const [row] = await this.database<{ id: string; roleIds: string[]; permissions: string[] }[]>`
      select u.id,
             coalesce(jsonb_agg(distinct r.id) filter (where r.id is not null), '[]') as "roleIds",
             coalesce(jsonb_agg(distinct permission.value) filter (where permission.value is not null), '[]') as permissions
        from users u
        left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
          and (ur.valid_until is null or ur.valid_until > now())
        left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
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

  private async resolveDataScopes(identity: IdentityRow, workspaceId: string | null) {
    const grants = await this.database<{ scopeValue: string }[]>`
      select distinct scope_value as "scopeValue" from data_scope_grants
       where tenant_id = ${tenantId}
         and (
           (subject_type = 'user' and subject_id = ${identity.id})
           or (subject_type = 'role' and subject_id in ${this.database(identity.roleIds)})
           or (${workspaceId ?? ''} <> '' and subject_type = 'workspace' and subject_id = ${workspaceId ?? ''})
         )
       order by scope_value
    `
    return grants.map(grant => grant.scopeValue)
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
      const [row] = await this.database<{ versionId: string }[]>`
        select sv.id as "versionId" from skills s
        join skill_versions sv on sv.tenant_id = s.tenant_id and sv.skill_id = s.id
         where s.tenant_id = ${tenantId} and s.id = ${id} and sv.version = ${version}
           and s.status = 'published' and sv.status = 'published'
      `
      if (!row) throw new Error(`Skill 不存在、未发布或已停用：${reference}`)
      resolved.push({ reference, versionId: row.versionId })
    }
    return resolved
  }

  private async resolveAndAuthorizeTools(
    references: string[],
    roleIds: string[],
    dataScopes: string[],
  ): Promise<CapabilityVersion[]> {
    const resolved: CapabilityVersion[] = []
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
      if (!intersects(roleIds, row.allowedRoleIds)) throw new Error(`当前用户角色不可调用工具：${reference}`)
      requireScopes(dataScopes, row.requiredDataScopes, `工具 ${reference}`)
      resolved.push({ reference, versionId: row.versionId })
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

function capabilityLabel(type: 'agent' | 'skill' | 'tool') {
  if (type === 'agent') return 'Agent'
  if (type === 'skill') return 'Skill'
  return '工具'
}
