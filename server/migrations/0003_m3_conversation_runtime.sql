-- M3 conversation orchestration and resumable event-stream support.

alter table run_events
  add column if not exists stream_position bigserial;

alter table messages
  add column if not exists run_id text;

alter table messages
  drop constraint if exists messages_run_fk;

alter table messages
  add constraint messages_run_fk
  foreign key (tenant_id, run_id) references runs(tenant_id, id);

create index if not exists messages_by_run
  on messages (tenant_id, run_id, created_at);

create unique index if not exists run_events_stream_position_unique
  on run_events (tenant_id, run_id, stream_position);

create index if not exists run_events_by_run_stream
  on run_events (tenant_id, run_id, stream_position);


insert into agents (
  id, tenant_id, name, description, welcome_message, owner_user_id, created_by, status
)
values (
  'agent-dsh-work-assistant', 'tenant-dsh-work', 'dsh-work 助手',
  '企业员工通用工作助手', '你好，我可以协助整理、分析和生成业务内容。',
  'U00008', 'U00008', 'published'
)
on conflict (id) do nothing;

insert into agent_versions (
  id, tenant_id, agent_id, version, system_prompt, visible_role_ids, data_scopes,
  status, published_at
)
values (
  'agent-version-dsh-work-assistant-1', 'tenant-dsh-work', 'agent-dsh-work-assistant',
  '1.0.0', '你是 dsh-work 企业员工助手。请给出准确、简洁、可执行的中文回答。',
  '["role-employee", "role-platform-admin"]', '["enterprise:authorized"]',
  'published', now()
)
on conflict (id) do nothing;

insert into workspaces (
  id, tenant_id, name, description, workspace_type, created_by, status
)
values
  ('ws-supply', 'tenant-dsh-work', '供应链经营分析', '供应链团队共享分析空间', 'team', 'U00001', 'active'),
  ('ws-operations', 'tenant-dsh-work', '月度经营复盘', '经营团队月度复盘空间', 'team', 'U00001', 'active')
on conflict (id) do nothing;

insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
values
  ('tenant-dsh-work', 'ws-supply', 'U00001', 'owner', 'U00001'),
  ('tenant-dsh-work', 'ws-operations', 'U00001', 'owner', 'U00001')
on conflict do nothing;

insert into runtimes (
  id, tenant_id, node_name, runtime_version, health_status, scheduling_status,
  capacity, last_heartbeat_at
)
values (
  'runtime-local-01', 'tenant-dsh-work', 'local-dsh-worker', '0.1.1-rc.2',
  'healthy', 'accepting', 2, now()
)
on conflict (id) do update set
  runtime_version = excluded.runtime_version,
  health_status = excluded.health_status,
  scheduling_status = excluded.scheduling_status,
  last_heartbeat_at = excluded.last_heartbeat_at;

insert into runtime_configurations (
  tenant_id, revision, concurrency_limit, timeout_seconds, sandbox_policy, updated_by
)
values (
  'tenant-dsh-work', 1, 2, 300,
  '{"network":"deny","write":"workspace_only","approval":"risk_based"}', 'U00008'
)
on conflict (tenant_id, revision) do nothing;
