-- 1A-T1 team workspace authorization foundation:
-- agent membership, grant provenance, revocation events, single-owner invariant.

-- ---------------------------------------------------------------------------
-- 1. agents.allow_workspace_join
-- ---------------------------------------------------------------------------
alter table agents
  add column allow_workspace_join boolean not null default true;

comment on column agents.allow_workspace_join is
  'Published agents are joinable by default; a platform admin can turn this off (admin governance switch, no API yet).';

-- ---------------------------------------------------------------------------
-- 2. workspaces.team_auth_revision
-- ---------------------------------------------------------------------------
alter table workspaces
  add column team_auth_revision integer not null default 0;

comment on column workspaces.team_auth_revision is
  'Bumped whenever team membership, roles or agent grants change; drives revocation cache invalidation.';

-- ---------------------------------------------------------------------------
-- 3. workspace_agent_members: team workspace <-> platform Agent association
-- ---------------------------------------------------------------------------
create table workspace_agent_members (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null references workspaces(id),
  agent_id text not null references agents(id),
  agent_version_id text not null references agent_versions(id),
  status text not null check (status in ('available', 'disabled', 'removed')),
  added_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, workspace_id, agent_id)
);

comment on table workspace_agent_members is
  'Associates a team workspace with a platform Agent. The same agent cannot be joined twice; re-adding after removal reuses the row (app-level behavior).';

create index if not exists workspace_agent_members_by_workspace_active
  on workspace_agent_members (tenant_id, workspace_id)
  where status <> 'removed';

-- ---------------------------------------------------------------------------
-- 4. workspace_grant_sources: multi-source provenance for workspace_capability_grants
-- ---------------------------------------------------------------------------
create table workspace_grant_sources (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null references workspaces(id),
  capability_type text not null check (capability_type in ('agent', 'skill', 'tool')),
  capability_version_id text not null,
  source_type text not null check (source_type in ('agent_member', 'manual', 'legacy_unresolved')),
  source_ref_id text,
  status text not null check (status in ('active', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

comment on table workspace_grant_sources is
  'Provenance for workspace_capability_grants rows. source_ref_id points at the workspace_agent_members row for agent_member sources, null otherwise.';

create index if not exists workspace_grant_sources_active_set
  on workspace_grant_sources (tenant_id, workspace_id, capability_type, capability_version_id)
  where status = 'active';

create index if not exists workspace_grant_sources_by_workspace
  on workspace_grant_sources (tenant_id, workspace_id);

-- ---------------------------------------------------------------------------
-- 5. workspace_revocation_events: durable, replayable revocation work items
-- ---------------------------------------------------------------------------
create table workspace_revocation_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null references workspaces(id),
  user_id text not null,
  kind text not null check (kind in ('member_removed', 'member_exit', 'role_changed', 'agent_disabled', 'agent_removed')),
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'processed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (workspace_id, user_id, kind, payload_hash)
);

comment on table workspace_revocation_events is
  'Revoked employee (or acting owner for agent events) work items. user_id is the revoked employee, or the actor for agent events.';

comment on column workspace_revocation_events.payload_hash is
  'Caller computes md5 of payload::text; the migration only defines the column. The unique key makes delivery idempotent.';

-- ---------------------------------------------------------------------------
-- 6. Team single-owner constraint (constraint trigger, deferred to commit)
-- ---------------------------------------------------------------------------
create or replace function assert_team_workspace_single_owner()
returns trigger language plpgsql as $$
declare
  target_tenant_id text;
  target_workspace_id text;
  target_workspace_type text;
  owner_count integer;
begin
  if tg_op = 'DELETE' then
    target_tenant_id := old.tenant_id;
    target_workspace_id := old.workspace_id;
  else
    target_tenant_id := new.tenant_id;
    target_workspace_id := new.workspace_id;
  end if;

  select workspace_type
    into target_workspace_type
    from workspaces
   where id = target_workspace_id;

  -- Personal spaces stay governed by personal_workspace_membership_guard (0013).
  if target_workspace_type = 'personal' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select count(*)::integer
    into owner_count
    from workspace_members
   where tenant_id = target_tenant_id
     and workspace_id = target_workspace_id
     and member_role = 'owner';

  if owner_count <> 1 then
    raise exception 'team workspace % must have exactly one owner (found %)',
      target_workspace_id, owner_count;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists team_workspace_single_owner on workspace_members;
create constraint trigger team_workspace_single_owner
  after insert or update or delete on workspace_members
  deferrable initially deferred
  for each row execute function assert_team_workspace_single_owner();

-- ---------------------------------------------------------------------------
-- 7. Legacy backfill: one legacy_unresolved source per existing capability grant
-- ---------------------------------------------------------------------------
insert into workspace_grant_sources (
  id, tenant_id, workspace_id, capability_type, capability_version_id,
  source_type, source_ref_id, status, created_by
)
select 'wgs-legacy-' || g.tenant_id || '-' || g.workspace_id || '-' || g.capability_type || '-' || g.capability_version_id,
       g.tenant_id,
       g.workspace_id,
       g.capability_type,
       g.capability_version_id,
       'legacy_unresolved',
       null,
       'active',
       w.created_by
  from workspace_capability_grants g
  join workspaces w
    on w.id = g.workspace_id
   and w.tenant_id = g.tenant_id
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 8. Owner anomaly diagnostics (report only; the constraint trigger governs future writes)
-- ---------------------------------------------------------------------------
do $$
declare
  anomaly_count integer;
  anomaly_ids text;
begin
  with team_owner_counts as (
    select w.id as workspace_id,
           (select count(*)::integer
              from workspace_members m
             where m.tenant_id = w.tenant_id
               and m.workspace_id = w.id
               and m.member_role = 'owner') as owner_count
      from workspaces w
     where w.workspace_type = 'team'
  )
  select count(*)::integer,
         coalesce(string_agg(workspace_id, ', ' order by workspace_id), '')
    into anomaly_count, anomaly_ids
    from team_owner_counts
   where owner_count <> 1;

  if anomaly_count > 0 then
    raise notice 'team workspace owner anomalies: % workspace(s) without exactly one owner: %',
      anomaly_count, anomaly_ids;
  end if;
end;
$$;
