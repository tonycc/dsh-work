-- M3 real Run observability projections used by the administration application.

alter table model_usage_events add column if not exists status text not null default 'success'
  check (status in ('success', 'failed', 'blocked'));
alter table model_usage_events add column if not exists trace_id text not null default '';
alter table model_usage_events add column if not exists estimated boolean not null default true;

insert into tools (id, tenant_id, key, name, source, status)
values ('tool-dsh-runtime', 'tenant-dsh-work', 'dsh-runtime-tool', 'DSH Runtime Tool', 'platform', 'available')
on conflict (id) do nothing;

insert into tool_versions (
  id, tenant_id, tool_id, version, input_schema, output_schema, risk_level
)
values (
  'tool-version-dsh-runtime-1', 'tenant-dsh-work', 'tool-dsh-runtime', '1.0.0',
  '{}', '{}', 'low'
)
on conflict (id) do nothing;
