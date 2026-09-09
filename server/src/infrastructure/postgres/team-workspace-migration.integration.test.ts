import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
const suffix = randomUUID()
const agentId = `agent-1a-${suffix}`
const teamWorkspaceId = `ws-1a-team-${suffix}`
const secondUserId = `user-1a-second-${suffix}`
const personalUserId = `user-1a-personal-${suffix}`
const personalWorkspaceId = `ws-personal-${personalUserId}`

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 4 })
  await runMigrations(database)
})

after(async () => {
  if (database) await database.end()
})

test('0022 applies once and installs the three authorization tables', async () => {
  const results = await runMigrations(database)
  assert.equal(results.every((result) => !result.applied), true)

  const [tables] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'public'
       and table_name in ('workspace_agent_members', 'workspace_grant_sources', 'workspace_revocation_events')
  `
  assert.equal(tables?.count, 3)

  const [functionRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_proc
     where proname = 'assert_team_workspace_single_owner'
  `
  assert.equal(functionRow?.count, 1)

  const [triggerRow] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from pg_trigger
     where tgname = 'team_workspace_single_owner'
       and not tgisinternal
  `
  assert.equal(triggerRow?.count, 1)
})

test('new tables enforce their check constraints', async () => {
  await assert.rejects(
    database`
      insert into workspace_agent_members (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
      values (${`wam-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent-dsh-work-assistant', 'agent-version-dsh-work-assistant-1', 'bogus', 'U00001')
    `,
    /workspace_agent_members_status_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'bogus', 'anything', 'manual', 'active', 'U00001')
    `,
    /workspace_grant_sources_capability_type_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-source-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent', 'agent-version-dsh-work-assistant-1', 'bogus', 'active', 'U00001')
    `,
    /workspace_grant_sources_source_type_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_grant_sources (id, tenant_id, workspace_id, capability_type, capability_version_id, source_type, status, created_by)
      values (${`wgs-bad-status-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'agent', 'agent-version-dsh-work-assistant-1', 'manual', 'bogus', 'U00001')
    `,
    /workspace_grant_sources_status_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload_hash)
      values (${`wre-bad-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'bogus', 'hash')
    `,
    /workspace_revocation_events_kind_check/,
  )

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload_hash, status)
      values (${`wre-bad-status-${suffix}`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', 'hash', 'bogus')
    `,
    /workspace_revocation_events_status_check/,
  )
})

test('allow_workspace_join defaults to true and team_auth_revision defaults to 0', async () => {
  await database`
    insert into agents (id, tenant_id, name, description, owner_user_id, created_by, status)
    values (${agentId}, 'tenant-dsh-work', '1A 授权测试 Agent', '验证默认允许加入团队空间', 'U00001', 'U00001', 'published')
  `
  const [agent] = await database<{ allowWorkspaceJoin: boolean }[]>`
    select allow_workspace_join as "allowWorkspaceJoin" from agents where id = ${agentId}
  `
  assert.equal(agent?.allowWorkspaceJoin, true)

  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${teamWorkspaceId}, 'tenant-dsh-work', '1A 团队空间', '', 'team', 'U00001', 'active')
  `
  const [workspace] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces where id = ${teamWorkspaceId}
  `
  assert.equal(workspace?.teamAuthRevision, 0)

  await database`
    update workspaces set team_auth_revision = team_auth_revision + 1 where id = ${teamWorkspaceId}
  `
  const [bumped] = await database<{ teamAuthRevision: number }[]>`
    select team_auth_revision as "teamAuthRevision" from workspaces where id = ${teamWorkspaceId}
  `
  assert.equal(bumped?.teamAuthRevision, 1)
})

test('team workspace keeps exactly one owner at commit', async () => {
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${secondUserId}, 'tenant-dsh-work', ${`bootstrap:${secondUserId}`}, '1A 第二成员', 'active')
  `

  // First owner insert succeeds.
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values ('tenant-dsh-work', ${teamWorkspaceId}, 'U00001', 'owner', 'U00001')
  `

  // A second owner is rejected when the transaction commits.
  await assert.rejects(
    database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values ('tenant-dsh-work', ${teamWorkspaceId}, ${secondUserId}, 'owner', 'U00001')
    `,
    /exactly one owner/,
  )

  // Non-owner roles are fine.
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values ('tenant-dsh-work', ${teamWorkspaceId}, ${secondUserId}, 'member', 'U00001')
  `

  // Promoting a member to a second owner is rejected as well.
  await assert.rejects(
    database`
      update workspace_members
         set member_role = 'owner'
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = ${secondUserId}
    `,
    /exactly one owner/,
  )

  // Removing the sole owner is rejected, leaving the owner row intact.
  await assert.rejects(
    database`
      delete from workspace_members
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${teamWorkspaceId}
         and user_id = 'U00001'
    `,
    /exactly one owner/,
  )

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)

  const [members] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${teamWorkspaceId}
  `
  assert.equal(members?.count, 2)
})

test('personal workspace memberships are untouched by the team owner trigger', async () => {
  // Creating an active user provisions their personal workspace via the 0013 triggers;
  // the deferred team trigger fires on that membership write too and must skip it.
  await database`
    insert into users (id, tenant_id, external_subject, display_name, status)
    values (${personalUserId}, 'tenant-dsh-work', ${`bootstrap:${personalUserId}`}, '1A 个人空间用户', 'active')
  `

  const [workspace] = await database<{ id: string; workspaceType: string }[]>`
    select id, workspace_type as "workspaceType"
      from workspaces
     where id = ${personalWorkspaceId}
  `
  assert.equal(workspace?.workspaceType, 'personal')

  const [owners] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_members
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
       and user_id = ${personalUserId}
       and member_role = 'owner'
  `
  assert.equal(owners?.count, 1)

  // A no-op update fires both membership triggers; the team trigger must skip personal rows.
  await database`
    update workspace_members
       set joined_at = joined_at
     where tenant_id = 'tenant-dsh-work'
       and workspace_id = ${personalWorkspaceId}
  `

  // The 0013 guard still governs personal rows: removing the owner fails with its own message.
  await assert.rejects(
    database`
      delete from workspace_members
       where tenant_id = 'tenant-dsh-work'
         and workspace_id = ${personalWorkspaceId}
         and user_id = ${personalUserId}
    `,
    /personal workspace owner membership cannot be removed/,
  )
})

test('legacy capability grants are backfilled with legacy_unresolved sources', async () => {
  const rows = await database<{
    id: string
    capabilityType: string
    capabilityVersionId: string
    sourceType: string
    sourceRefId: string | null
    status: string
    createdBy: string
  }[]>`
    select s.id,
           s.capability_type as "capabilityType",
           s.capability_version_id as "capabilityVersionId",
           s.source_type as "sourceType",
           s.source_ref_id as "sourceRefId",
           s.status,
           s.created_by as "createdBy"
      from workspace_grant_sources s
     where s.tenant_id = 'tenant-dsh-work'
       and s.workspace_id = 'ws-supply'
       and s.capability_type = 'agent'
       and s.capability_version_id = 'agent-version-dsh-work-assistant-1'
  `
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.id, 'wgs-legacy-tenant-dsh-work-ws-supply-agent-agent-version-dsh-work-assistant-1')
  assert.equal(row.sourceType, 'legacy_unresolved')
  assert.equal(row.sourceRefId, null)
  assert.equal(row.status, 'active')
  assert.equal(row.createdBy, 'U00001')

  // Every seeded grant has exactly one matching legacy source.
  const [counts] = await database<{ grants: number; sources: number }[]>`
    select (select count(*)::integer from workspace_capability_grants g
             where g.tenant_id = 'tenant-dsh-work') as grants,
           (select count(*)::integer from workspace_grant_sources s
             where s.tenant_id = 'tenant-dsh-work'
               and s.source_type = 'legacy_unresolved') as sources
  `
  assert.equal(counts?.grants, counts?.sources)
})

test('revocation events dedupe on (workspace_id, user_id, kind, payload_hash)', async () => {
  const payloadHash = `md5-${suffix}`
  await database`
    insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
    values (${`wre-${suffix}-1`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"member"}'::jsonb, ${payloadHash})
  `

  const [created] = await database<{ status: string; attempts: number; payload: Record<string, unknown> }[]>`
    select status, attempts, payload
      from workspace_revocation_events
     where id = ${`wre-${suffix}-1`}
  `
  assert.equal(created?.status, 'pending')
  assert.equal(created?.attempts, 0)
  assert.deepEqual(created?.payload, { role: 'member' })

  await assert.rejects(
    database`
      insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
      values (${`wre-${suffix}-2`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"member"}'::jsonb, ${payloadHash})
    `,
    /workspace_revocation_events_workspace_id_user_id_kind_paylo(_hash)?_key/,
  )

  // Same tuple with a different payload hash is a distinct event.
  await database`
    insert into workspace_revocation_events (id, tenant_id, workspace_id, user_id, kind, payload, payload_hash)
    values (${`wre-${suffix}-3`}, 'tenant-dsh-work', 'ws-supply', 'U00001', 'member_removed', '{"role":"owner"}'::jsonb, ${`md5-${suffix}-other`})
  `
})
