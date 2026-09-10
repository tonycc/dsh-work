import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

export type WorkspaceCapabilityType = 'agent' | 'skill' | 'tool'
export type GrantSourceType = 'agent_member' | 'manual' | 'legacy_unresolved'

export interface GrantSourceInput {
  capabilityType: WorkspaceCapabilityType
  capabilityVersionId: string
  sourceType: GrantSourceType
  sourceRefId?: string
  createdBy: string
}

export interface GrantSourceRecord {
  id: string
  sourceType: GrantSourceType
  sourceRefId: string | null
  createdBy: string
  createdAt: Date
}

export interface CapabilityGrantSourceGroup {
  capabilityType: WorkspaceCapabilityType
  capabilityVersionId: string
  sources: GrantSourceRecord[]
}

/**
 * Maintains the provenance of `workspace_capability_grants` (the effective set)
 * through `workspace_grant_sources`. Lives in the authorization module because
 * both tables are authorization-domain objects, the runtime capability check
 * (`PostgresAuthorizationService.requireWorkspaceCapabilities`) reads the same
 * effective set, and T3-T5 need `bumpTeamAuthRevision` without depending on the
 * workbench application layer.
 */
export class PostgresWorkspaceGrantSourceService {
  async addGrantSources(
    tx: DatabaseTransaction,
    sources: GrantSourceInput[],
    workspaceId: string,
  ) {
    // Serialize all grant source mutations per workspace: concurrent
    // add/revoke sweeps must not interleave into a grant with zero active
    // sources (write skew under READ COMMITTED). Same pattern the plan
    // prescribes for owner transfers.
    await lockWorkspaceForGrantSync(tx, workspaceId)
    for (const source of sources) {
      if (source.sourceType === 'agent_member') {
        if (!source.sourceRefId) {
          throw new Error('Agent 成员授权来源必须指定 sourceRefId（关联的 Agent 成员）')
        }
        // The partial unique index workspace_grant_sources_agent_member_once
        // covers revoked rows too: re-adding after a revoke must reactivate
        // the existing provenance row instead of being silently skipped
        // (which would leave the recreated grant without any active source).
        await tx`
          insert into workspace_grant_sources (
            id, tenant_id, workspace_id, capability_type, capability_version_id,
            source_type, source_ref_id, status, created_by
          ) values (
            ${`wgs-${randomUUID()}`}, ${tenantId}, ${workspaceId},
            ${source.capabilityType}, ${source.capabilityVersionId},
            ${source.sourceType}, ${source.sourceRefId}, 'active', ${source.createdBy}
          )
          on conflict (tenant_id, workspace_id, capability_type, capability_version_id, source_ref_id)
            where source_type = 'agent_member'
          do update set status = 'active', revoked_at = null
        `
      } else {
        await tx`
          insert into workspace_grant_sources (
            id, tenant_id, workspace_id, capability_type, capability_version_id,
            source_type, source_ref_id, status, created_by
          ) values (
            ${`wgs-${randomUUID()}`}, ${tenantId}, ${workspaceId},
            ${source.capabilityType}, ${source.capabilityVersionId},
            ${source.sourceType}, ${source.sourceRefId ?? null}, 'active', ${source.createdBy}
          )
          on conflict do nothing
        `
      }
      await tx`
        insert into workspace_capability_grants (
          tenant_id, workspace_id, capability_type, capability_version_id
        ) values (
          ${tenantId}, ${workspaceId}, ${source.capabilityType}, ${source.capabilityVersionId}
        )
        on conflict do nothing
      `
    }
    await bumpTeamAuthRevision(tx, workspaceId)
  }

  async revokeGrantSourcesByRef(
    tx: DatabaseTransaction,
    workspaceId: string,
    sourceRefId: string,
  ) {
    await lockWorkspaceForGrantSync(tx, workspaceId)
    await tx`
      update workspace_grant_sources
         set status = 'revoked', revoked_at = now()
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and source_type = 'agent_member' and source_ref_id = ${sourceRefId}
         and status = 'active'
    `
    await tx`
      delete from workspace_capability_grants g
       where g.tenant_id = ${tenantId} and g.workspace_id = ${workspaceId}
         and not exists (
           select 1 from workspace_grant_sources s
            where s.tenant_id = g.tenant_id and s.workspace_id = g.workspace_id
              and s.capability_type = g.capability_type
              and s.capability_version_id = g.capability_version_id
              and s.status = 'active'
         )
    `
    await bumpTeamAuthRevision(tx, workspaceId)
  }

  async listGrantSources(
    database: DatabaseClient | DatabaseTransaction,
    workspaceId: string,
  ): Promise<CapabilityGrantSourceGroup[]> {
    const rows = await database<{
      id: string
      capabilityType: WorkspaceCapabilityType
      capabilityVersionId: string
      sourceType: GrantSourceType
      sourceRefId: string | null
      createdBy: string
      createdAt: Date
    }[]>`
      select id, capability_type as "capabilityType",
             capability_version_id as "capabilityVersionId",
             source_type as "sourceType", source_ref_id as "sourceRefId",
             created_by as "createdBy", created_at as "createdAt"
        from workspace_grant_sources
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
         and status = 'active'
       order by capability_type, capability_version_id, created_at
    `
    const groups = new Map<string, CapabilityGrantSourceGroup>()
    for (const row of rows) {
      const key = `${row.capabilityType}|${row.capabilityVersionId}`
      let group = groups.get(key)
      if (!group) {
        group = {
          capabilityType: row.capabilityType,
          capabilityVersionId: row.capabilityVersionId,
          sources: [],
        }
        groups.set(key, group)
      }
      group.sources.push({
        id: row.id,
        sourceType: row.sourceType,
        sourceRefId: row.sourceRefId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      })
    }
    return [...groups.values()]
  }
}

/**
 * Serializes grant source mutations per workspace by locking the workspace
 * row. Both `addGrantSources` and `revokeGrantSourcesByRef` must take this
 * lock as their first statement so the update-then-sweep-delete sequence
 * cannot interleave across concurrent transactions (write skew under
 * READ COMMITTED would otherwise leave a grant with zero active sources).
 */
async function lockWorkspaceForGrantSync(tx: DatabaseTransaction, workspaceId: string) {
  await tx`
    select id from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
     for update
  `
}

/**
 * Bumps the team authorization generation counter on the workspace row.
 * Exported as a free function so membership/role services (T3-T5) can call it
 * inside their own transactions without constructing this service. Limited to
 * team workspaces: personal workspace rows are never touched by team sync.
 */
export async function bumpTeamAuthRevision(tx: DatabaseTransaction, workspaceId: string) {
  await tx`
    update workspaces
       set team_auth_revision = team_auth_revision + 1
     where tenant_id = ${tenantId} and id = ${workspaceId}
       and workspace_type = 'team'
  `
}
