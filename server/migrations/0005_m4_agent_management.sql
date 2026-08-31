-- M4-01 durable Agent lifecycle, test evidence and active-version pointers.

drop trigger if exists agent_versions_immutable on agent_versions;

alter table agents
  add column if not exists active_version_id text,
  add column if not exists draft_version_id text;

alter table agent_versions
  add column if not exists name text not null default '',
  add column if not exists description text not null default '',
  add column if not exists welcome_message text not null default '',
  add column if not exists example_prompts jsonb not null default '[]'::jsonb,
  add column if not exists max_tokens integer not null default 12000 check (max_tokens between 1024 and 32768),
  add column if not exists timeout_seconds integer not null default 300 check (timeout_seconds between 30 and 600),
  add column if not exists skill_refs jsonb not null default '[]'::jsonb,
  add column if not exists tool_refs jsonb not null default '[]'::jsonb,
  add column if not exists created_by text,
  add column if not exists published_by text,
  add column if not exists source_version text,
  add column if not exists change_summary text not null default '';

update agent_versions av
   set name = a.name,
       description = a.description,
       welcome_message = coalesce(a.welcome_message, ''),
       example_prompts = '["请介绍你能提供哪些帮助"]'::jsonb,
       created_by = a.created_by,
       change_summary = case when av.change_summary = '' then 'M3 初始发布版本' else av.change_summary end
  from agents a
 where a.tenant_id = av.tenant_id and a.id = av.agent_id and av.name = '';

update agents a
   set active_version_id = av.id
  from agent_versions av
 where av.tenant_id = a.tenant_id
   and av.agent_id = a.id
   and av.status = 'published'
   and a.active_version_id is null;

alter table agents
  add constraint agents_active_version_fk
  foreign key (tenant_id, active_version_id) references agent_versions(tenant_id, id),
  add constraint agents_draft_version_fk
  foreign key (tenant_id, draft_version_id) references agent_versions(tenant_id, id);

alter table agent_versions
  add constraint agent_versions_created_by_fk
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  add constraint agent_versions_published_by_fk
  foreign key (tenant_id, published_by) references users(tenant_id, id);

create table agent_test_runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  configuration_fingerprint text not null,
  test_prompt text not null,
  status text not null check (status in ('passed', 'failed')),
  result_summary text not null,
  tested_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, tested_by) references users(tenant_id, id)
);

create index agent_test_runs_by_version
  on agent_test_runs (tenant_id, agent_version_id, created_at desc);

create table agent_release_records (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  action text not null check (action in ('published', 'enabled', 'disabled', 'rollback')),
  actor_id text not null,
  note text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, actor_id) references users(tenant_id, id)
);

create index agent_release_records_by_agent
  on agent_release_records (tenant_id, agent_id, created_at desc);

create trigger agent_versions_immutable before update or delete on agent_versions
  for each row execute function prevent_published_version_update();
