-- M4-06 server-authoritative identity, role, data-scope and workspace capability baseline.

update roles
   set permissions = '["admin:*", "workbench:use"]'::jsonb
 where tenant_id = 'tenant-dsh-work' and id = 'role-platform-admin';

insert into data_scope_grants (id, tenant_id, subject_type, subject_id, scope_code, scope_value)
values
  ('grant-role-employee-enterprise', 'tenant-dsh-work', 'role', 'role-employee', 'capability', 'enterprise:authorized'),
  ('grant-role-employee-workspace', 'tenant-dsh-work', 'role', 'role-employee', 'capability', 'workspace:authorized'),
  ('grant-role-admin-enterprise', 'tenant-dsh-work', 'role', 'role-platform-admin', 'capability', 'enterprise:authorized'),
  ('grant-role-admin-workspace', 'tenant-dsh-work', 'role', 'role-platform-admin', 'capability', 'workspace:authorized'),
  ('grant-workspace-supply-domain', 'tenant-dsh-work', 'workspace', 'ws-supply', 'capability', 'domain:supply-chain'),
  ('grant-workspace-operations-domain', 'tenant-dsh-work', 'workspace', 'ws-operations', 'capability', 'domain:operations')
on conflict do nothing;

drop trigger if exists agent_versions_immutable on agent_versions;

update agent_versions
   set data_scopes = '["enterprise:authorized", "workspace:authorized"]'::jsonb,
       skill_refs = '["skill-document@1.0.0"]'::jsonb,
       tool_refs = '["read@1.0.0"]'::jsonb,
       change_summary = 'M4-06 默认 Agent 权限与能力基线'
 where tenant_id = 'tenant-dsh-work'
   and id = 'agent-version-dsh-work-assistant-1';

create trigger agent_versions_immutable before update or delete on agent_versions
  for each row execute function prevent_published_version_update();

update tools
   set allowed_role_ids = '["role-employee", "role-platform-admin"]'::jsonb,
       data_scopes = '["workspace:authorized"]'::jsonb,
       updated_at = now()
 where tenant_id = 'tenant-dsh-work' and id in ('read', 'glob', 'grep');

insert into workspace_capability_grants (
  tenant_id, workspace_id, capability_type, capability_version_id
)
select 'tenant-dsh-work', workspace_id, capability_type, capability_version_id
  from (values
    ('ws-supply', 'agent', 'agent-version-dsh-work-assistant-1'),
    ('ws-supply', 'skill', 'skill-version-document-1'),
    ('ws-supply', 'tool', 'tool-version-read-1'),
    ('ws-operations', 'agent', 'agent-version-dsh-work-assistant-1'),
    ('ws-operations', 'skill', 'skill-version-document-1'),
    ('ws-operations', 'tool', 'tool-version-read-1')
  ) as grants(workspace_id, capability_type, capability_version_id)
on conflict do nothing;

create index if not exists data_scope_grants_by_subject
  on data_scope_grants (tenant_id, subject_type, subject_id);
create index if not exists workspace_capability_grants_by_workspace
  on workspace_capability_grants (tenant_id, workspace_id, capability_type);
