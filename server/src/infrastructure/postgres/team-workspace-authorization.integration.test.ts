import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { PostgresWorkspaceGrantSourceService } from '../../modules/authorization/postgres-workspace-grant-source-service.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID()

let database: DatabaseClient
let authorization: PostgresAuthorizationService
let grantSources: PostgresWorkspaceGrantSourceService
let agents: PostgresAgentService

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 4 })
  await runMigrations(database)
  authorization = new PostgresAuthorizationService(database)
  grantSources = new PostgresWorkspaceGrantSourceService()
  agents = new PostgresAgentService(database)
})

after(async () => {
  if (database) await database.end()
})

// ---------------------------------------------------------------------------
// 1. requireTeamRole
// ---------------------------------------------------------------------------

test('requireTeamRole enforces team member roles and rejects non-members', async () => {
  const workspaceId = `ws-t2-role-${suffix}`
  const ownerId = `user-t2-owner-${suffix}`
  const adminId = `user-t2-admin-${suffix}`
  const memberId = `user-t2-member-${suffix}`
  const viewerId = `user-t2-viewer-${suffix}`
  const outsiderId = `user-t2-outsider-${suffix}`
  await createUser(ownerId, 'T2 负责人')
  await createUser(adminId, 'T2 管理员')
  await createUser(memberId, 'T2 成员')
  await createUser(viewerId, 'T2 只读成员')
  await createUser(outsiderId, 'T2 非成员')
  await createTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: adminId, role: 'admin' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])

  // Owner passes owner-only and wider role sets.
  await authorization.requireTeamRole(workspaceId, ownerId, ['owner'])
  await authorization.requireTeamRole(workspaceId, ownerId, ['owner', 'admin', 'member', 'viewer'])

  // Member fails owner-only roles.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, memberId, ['owner']),
    /无权执行/,
  )
  // Member passes member/viewer roles.
  await authorization.requireTeamRole(workspaceId, memberId, ['member', 'viewer'])

  // Admin passes admin roles, fails owner-only roles.
  await authorization.requireTeamRole(workspaceId, adminId, ['owner', 'admin'])
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, adminId, ['owner']),
    /无权执行/,
  )

  // Viewer rejected where not allowed, allowed where listed.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, viewerId, ['owner', 'admin', 'member']),
    /无权执行/,
  )
  await authorization.requireTeamRole(workspaceId, viewerId, ['viewer'])

  // Non-member rejected with the existing membership wording.
  await assert.rejects(
    authorization.requireTeamRole(workspaceId, outsiderId, ['owner', 'admin', 'member', 'viewer']),
    /不是成员/,
  )

  // Unknown workspace rejected with the existing membership wording.
  await assert.rejects(
    authorization.requireTeamRole(`ws-t2-missing-${suffix}`, ownerId, ['owner']),
    /不是成员/,
  )
})

test('requireTeamRole is a no-op for personal workspaces', async () => {
  const personalWorkspaceId = 'ws-personal-U00001'
  // The personal space owner passes.
  await authorization.requireTeamRole(personalWorkspaceId, 'U00001', ['owner'])
  // Team role checks are skipped entirely for personal spaces: even a user
  // who is not the personal space owner is not subjected to a role check.
  await authorization.requireTeamRole(personalWorkspaceId, 'U00008', ['owner'])
})

// ---------------------------------------------------------------------------
// 2. resolveWorkspaceOwner
// ---------------------------------------------------------------------------

test('resolveWorkspaceOwner returns the single owner', async () => {
  const workspaceId = `ws-t2-owner-${suffix}`
  const ownerId = `user-t2-owner-single-${suffix}`
  await createUser(ownerId, 'T2 负责人')
  await createTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  assert.equal(await authorization.resolveWorkspaceOwner(workspaceId), ownerId)
})

test('resolveWorkspaceOwner throws when the workspace has no owner', async () => {
  const workspaceId = `ws-t2-ownerless-${suffix}`
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 无负责人空间', '', 'team', 'U00001', 'active')
  `
  await assert.rejects(
    authorization.resolveWorkspaceOwner(workspaceId),
    /负责人/,
  )
})

test('resolveWorkspaceOwner throws when two owners exist (trigger bypassed via SQL)', async () => {
  const workspaceId = `ws-t2-two-owners-${suffix}`
  const firstOwnerId = `user-t2-two-a-${suffix}`
  const secondOwnerId = `user-t2-two-b-${suffix}`
  await createUser(firstOwnerId, 'T2 负责人甲')
  await createUser(secondOwnerId, 'T2 负责人乙')
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 双负责人空间', '', 'team', 'U00001', 'active')
  `
  try {
    await insertOwnersBypassingTrigger(workspaceId, [firstOwnerId, secondOwnerId])
    await assert.rejects(
      authorization.resolveWorkspaceOwner(workspaceId),
      /负责人/,
    )
  } finally {
    await removeWorkspaceBypassingTrigger(workspaceId)
  }
})

// ---------------------------------------------------------------------------
// 3. Grant source sync
// ---------------------------------------------------------------------------

test('addGrantSources syncs the effective grant set and is idempotent per agent member source', async () => {
  const workspaceId = `ws-t2-grant-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  const memberRefB = `wam-t2-b-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefB, createdBy: 'U00001' },
      { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Effective grants contain exactly the union of the added tuples.
  const grants = await listGrants(workspaceId)
  assert.deepEqual(grants, [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1' },
  ])

  // Three active sources were recorded.
  assert.equal(await countSources(workspaceId), 3)
  assert.equal(await revisionOf(workspaceId), 1)

  // Re-adding the same agent_member source tuple is idempotent (partial unique index).
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })
  assert.equal(await countSources(workspaceId), 3)
  assert.deepEqual(await listGrants(workspaceId), grants)
  assert.equal(await revisionOf(workspaceId), 2)
})

test('revokeGrantSourcesByRef keeps grants with remaining active sources and deletes the rest', async () => {
  const workspaceId = `ws-t2-revoke-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  const memberRefB = `wam-t2-b-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefB, createdBy: 'U00001' },
      { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
    ], workspaceId)
  })

  // Revoke one of two sources for the agent tuple: the grant must remain (AC-26).
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefB)
  })
  assert.deepEqual(await listGrants(workspaceId), [
    { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1' },
    { capabilityType: 'skill', capabilityVersionId: 'skill-version-document-1' },
  ])
  const [revoked] = await database<{ status: string; revokedAt: Date | null }[]>`
    select status, revoked_at as "revokedAt" from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
       and source_ref_id = ${memberRefB}
  `
  assert.equal(revoked?.status, 'revoked')
  assert.ok(revoked?.revokedAt)
  assert.equal(await revisionOf(workspaceId), 2)

  // Revoke the last source for each tuple: grants are deleted.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
  })
  assert.deepEqual(await listGrants(workspaceId), [])
  assert.equal(await countActiveSources(workspaceId), 0)
  assert.equal(await revisionOf(workspaceId), 3)
})

test('listGrantSources groups active sources by capability and includes legacy sources', async () => {
  // The seeded ws-supply grants were backfilled with legacy_unresolved sources by migration 0022.
  await database.begin(async transaction => {
    const groups = await grantSources.listGrantSources(transaction, 'ws-supply')
    assert.equal(groups.length, 3)
    for (const group of groups) {
      assert.equal(group.sources.length, 1)
      assert.equal(group.sources[0]?.sourceType, 'legacy_unresolved')
      assert.equal(group.sources[0]?.sourceRefId, null)
    }
  })

  const workspaceId = `ws-t2-list-${suffix}`
  const memberRefA = `wam-t2-a-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])
  await database.begin(async transaction => {
    await grantSources.addGrantSources(transaction, [
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'agent_member', sourceRefId: memberRefA, createdBy: 'U00001' },
      { capabilityType: 'agent', capabilityVersionId: 'agent-version-dsh-work-assistant-1', sourceType: 'manual', createdBy: 'U00008' },
    ], workspaceId)
  })

  await database.begin(async transaction => {
    const groups = await grantSources.listGrantSources(transaction, workspaceId)
    assert.equal(groups.length, 1)
    const [group] = groups
    assert.equal(group?.capabilityType, 'agent')
    assert.equal(group?.capabilityVersionId, 'agent-version-dsh-work-assistant-1')
    assert.deepEqual(
      group?.sources.map(source => source.sourceType).sort(),
      ['agent_member', 'manual'],
    )
  })

  // After revoking the agent member source, only the manual source remains active.
  await database.begin(async transaction => {
    await grantSources.revokeGrantSourcesByRef(transaction, workspaceId, memberRefA)
    const groups = await grantSources.listGrantSources(transaction, workspaceId)
    assert.equal(groups.length, 1)
    assert.deepEqual(
      groups[0]?.sources.map(source => source.sourceType),
      ['manual'],
    )
  })
})

// ---------------------------------------------------------------------------
// 4. Agent candidate filtering for team spaces
// ---------------------------------------------------------------------------

test('listWorkspaceAgentCandidates filters by publish state, join allowance, visible roles and membership', async () => {
  const workspaceId = `ws-t2-cand-${suffix}`
  await createTeamWorkspace(workspaceId, [{ userId: 'U00001', role: 'owner' }])

  // Snapshot of the personal list before candidates are created.
  const personalListBefore = (await agents.listWorkbenchAgents('U00001')).map(agent => agent.id)

  const joinable = await createCandidateAgent({ id: `agent-t2-joinable-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'] })
  const disabled = await createCandidateAgent({ id: `agent-t2-disabled-${suffix}`, status: 'disabled', allowJoin: true, roleIds: ['role-employee'] })
  const draft = await createCandidateAgent({ id: `agent-t2-draft-${suffix}`, status: 'draft', allowJoin: true, roleIds: ['role-employee'] })
  const notAllowed = await createCandidateAgent({ id: `agent-t2-not-allowed-${suffix}`, status: 'published', allowJoin: false, roleIds: ['role-employee'] })
  const wrongRole = await createCandidateAgent({ id: `agent-t2-wrong-role-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-platform-admin'] })
  const joined = await createCandidateAgent({ id: `agent-t2-joined-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'], memberStatus: 'available', workspaceId })
  const removedMember = await createCandidateAgent({ id: `agent-t2-removed-${suffix}`, status: 'published', allowJoin: true, roleIds: ['role-employee'], memberStatus: 'removed', workspaceId })

  const candidates = await agents.listWorkspaceAgentCandidates(workspaceId, 'U00001')
  const ids = candidates.map(candidate => candidate.id)

  assert.ok(ids.includes(joinable.id))
  assert.ok(ids.includes('agent-dsh-work-assistant'), 'seeded published joinable agent is a candidate')
  assert.ok(ids.includes(removedMember.id), 'a removed membership no longer blocks the picker')
  assert.ok(!ids.includes(disabled.id))
  assert.ok(!ids.includes(draft.id))
  assert.ok(!ids.includes(notAllowed.id))
  assert.ok(!ids.includes(wrongRole.id))
  assert.ok(!ids.includes(joined.id))

  const candidate = candidates.find(item => item.id === joinable.id)
  assert.deepEqual(candidate?.activeVersion, {
    id: joinable.versionId,
    version: '1.0.0',
    status: 'published',
  })

  // Session-provided roles resolve the same way listWorkbenchAgents does:
  // the platform-admin-visible candidate and the seeded assistant both match.
  const sessionCandidates = await agents.listWorkspaceAgentCandidates(workspaceId, 'U00001', ['role-platform-admin'])
  assert.deepEqual(
    sessionCandidates.map(item => item.id).sort(),
    [wrongRole.id, 'agent-dsh-work-assistant'].sort(),
  )

  // The personal-space list path is untouched: every previously listed agent is still listed.
  const personalListAfter = (await agents.listWorkbenchAgents('U00001')).map(agent => agent.id)
  for (const id of personalListBefore) assert.ok(personalListAfter.includes(id))
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(id: string, displayName: string) {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${id}, ${tenantId}, ${`bootstrap:${id}`}, ${displayName}, 'active')
  `
}

async function createTeamWorkspace(workspaceId: string, members: Array<{ userId: string; role: string }>) {
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, 'T2 测试团队空间', '', 'team', 'U00001', 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, 'U00001')
    `
  }
}

async function insertOwnersBypassingTrigger(workspaceId: string, ownerIds: string[]) {
  await database.begin(async transaction => {
    await transaction.unsafe('alter table workspace_members disable trigger team_workspace_single_owner')
    for (const ownerId of ownerIds) {
      await transaction`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${workspaceId}, ${ownerId}, 'owner', 'U00001')
      `
    }
  })
  await database.unsafe('alter table workspace_members enable trigger team_workspace_single_owner')
}

async function removeWorkspaceBypassingTrigger(workspaceId: string) {
  await database.begin(async transaction => {
    await transaction.unsafe('alter table workspace_members disable trigger team_workspace_single_owner')
    await transaction`
      delete from workspace_members where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
    `
    await transaction`
      delete from workspaces where tenant_id = ${tenantId} and id = ${workspaceId}
    `
  })
  await database.unsafe('alter table workspace_members enable trigger team_workspace_single_owner')
}

async function listGrants(workspaceId: string) {
  const rows = await database<{ capabilityType: string; capabilityVersionId: string }[]>`
    select capability_type as "capabilityType", capability_version_id as "capabilityVersionId"
      from workspace_capability_grants
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
     order by capability_type, capability_version_id
  `
  return rows.map(row => ({
    capabilityType: row.capabilityType,
    capabilityVersionId: row.capabilityVersionId,
  }))
}

async function countSources(workspaceId: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
  `
  return row?.count ?? 0
}

async function countActiveSources(workspaceId: string) {
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_grant_sources
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and status = 'active'
  `
  return row?.count ?? 0
}

async function revisionOf(workspaceId: string) {
  const [row] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
  return row?.teamAuthRevision ?? 0
}

async function createCandidateAgent(input: {
  id: string
  status: 'published' | 'disabled' | 'draft'
  allowJoin: boolean
  roleIds: string[]
  memberStatus?: 'available' | 'removed'
  workspaceId?: string
}) {
  const versionId = `agent-version-${input.id}`
  const versionStatus = input.status === 'draft' ? 'draft' : 'published'
  await database.begin(async transaction => {
    await transaction`
      insert into agents (
        id, tenant_id, name, description, welcome_message, owner_user_id, created_by,
        status, active_version_id, allow_workspace_join
      ) values (
        ${input.id}, ${tenantId}, '候选测试 Agent', '用于验证团队空间 Agent 候选过滤。', '',
        'U00001', 'U00001', ${input.status}, null, ${input.allowJoin}
      )
    `
    await transaction`
      insert into agent_versions (
        id, tenant_id, agent_id, version, name, description, welcome_message,
        example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
        timeout_seconds, skill_refs, tool_refs, status, created_by, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${input.id}, '1.0.0', '候选测试 Agent', '用于验证团队空间 Agent 候选过滤。',
        '', ${transaction.json(['测试'] as string[])}, '你是候选测试 Agent。',
        ${transaction.json(input.roleIds)}, ${transaction.json(['enterprise:authorized'] as string[])},
        12000, 300, ${transaction.json([] as string[])}, ${transaction.json([] as string[])},
        ${versionStatus}, 'U00001', '候选过滤测试'
      )
    `
    if (input.status !== 'draft') {
      await transaction`
        update agents set active_version_id = ${versionId}
         where tenant_id = ${tenantId} and id = ${input.id}
      `
    }
  })
  if (input.memberStatus && input.workspaceId) {
    await database`
      insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
      values (${`wam-${input.id}`}, ${tenantId}, ${input.workspaceId}, ${input.id}, ${versionId}, ${input.memberStatus}, 'U00001')
    `
  }
  return { id: input.id, versionId }
}
