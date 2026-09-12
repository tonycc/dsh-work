-- ---------------------------------------------------------------------------
-- 0026: team workspace activity feed and in-app notification read state
--      (batch 3 / 3-T7 / TW-08)
--
-- TW-08 needs a durable, permission-filtered activity projection. The survey in
-- docs/product/team-workspace-batch-3-tasks.md (3-T7 事件源核查) found that the
-- existing sources cannot serve it:
--   * workspace_revocation_events is the access-revocation input. It dedupes by
--     revocation payload (a transfer writes two role_changed rows) and carries
--     no file or archive facts;
--   * file upload/removal wrote no event at all before this migration;
--   * audit_events is the platform-governance projection (different audience);
--   * run_events describes one Run; plain messages and run execution details
--     must never surface in team activity (TW-08 §2).
-- So this migration adds an append-only activity fact table plus a per-user
-- read/mute state table. Personal workspaces are out of scope (AC-23): nothing
-- writes these rows for them and no personal endpoint reads them.
--
-- This migration intentionally performs NO backfill: historical activity must
-- not be invented (task doc 3-T7「不清点历史动态」), and no existing table is
-- altered, so replaying it changes nothing.
-- ---------------------------------------------------------------------------

create table if not exists workspace_activity_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  kind text not null check (kind in (
    'member_added',
    'member_removed',
    'member_exit',
    'role_changed',
    'owner_transferred',
    'agent_member_added',
    'agent_member_removed',
    'file_uploaded',
    'file_removed',
    'file_version_added',
    'workspace_archived',
    'workspace_restored'
  )),
  actor_user_id text not null,
  object_type text not null check (object_type in ('member', 'agent_member', 'file', 'workspace')),
  object_id text not null,
  safe_metadata jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  occurred_at timestamptz not null default now(),
  unique (tenant_id, workspace_id, dedupe_key),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references users(tenant_id, id)
);

comment on table workspace_activity_events is
  'Append-only team workspace activity fact. Written in the SAME transaction as the business change that produced it, so a committed row always describes a committed change and a rolled-back change never leaves activity behind. Personal workspaces never get rows here (AC-23).';

comment on column workspace_activity_events.kind is
  'Business event kind. Messages, unshared conversation activity and Run execution details are deliberately absent (TW-08: 普通发送消息与未共享对话活动不进入团队动态).';

comment on column workspace_activity_events.actor_user_id is
  'The employee who performed the change; for member_exit this is the exiting member. The reader joins users for the display name, so a renamed/deactivated employee stays resolvable.';

comment on column workspace_activity_events.object_type is
  'Type of the id in object_id: member / agent_member / file / workspace.';

comment on column workspace_activity_events.object_id is
  'Safe object reference (an id only, never a name or body). Every read re-resolves it through the current read gate, so a member who lost access cannot use a historical id to read the object.';

comment on column workspace_activity_events.safe_metadata is
  'Minimal extras every CURRENT member may see: a role, a from/to role pair, an agent id, a version number. It must never carry private conversation text, session attachment names, credentials or hidden inference; feed items show workspace files by id and let the file list (already member-readable) resolve the name.';

comment on column workspace_activity_events.dedupe_key is
  'Identity of the business occurrence. The unique key (tenant_id, workspace_id, dedupe_key) makes a duplicate write a no-op, so a repeated/retried action cannot produce a second activity row (AC-15).';

comment on column workspace_activity_events.occurred_at is
  'Business change time (defaults to the writing transaction start). Feed ordering is (occurred_at desc, id desc) and keyset pagination walks that same tuple.';

-- Feed / unread queries are always scoped to one workspace and ordered newest
-- first; the same index serves unread counting with occurred_at > last_read_at.
create index if not exists workspace_activity_events_feed
  on workspace_activity_events (tenant_id, workspace_id, occurred_at desc, id desc);

create table if not exists workspace_notification_states (
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  user_id text not null,
  last_read_at timestamptz,
  muted_at timestamptz,
  primary key (tenant_id, workspace_id, user_id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

comment on table workspace_notification_states is
  'Per user per workspace in-app notification state. One row exists only once the user has read or muted the workspace; absent means "never read, never muted".';

comment on column workspace_notification_states.last_read_at is
  'Unread = activity with occurred_at > last_read_at (null = everything is unread). Mark-as-read advances it; activity at or before it is considered read.';

comment on column workspace_notification_states.muted_at is
  'Non-null = reminders are switched off for this workspace: unread count is reported as 0 and nothing is surfaced as a reminder. Muting never hides activity from the feed and never deletes read state.';
