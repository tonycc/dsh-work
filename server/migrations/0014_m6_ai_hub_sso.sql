-- AI Hub OIDC login transactions, server-side sessions, and managed role mapping.

alter table file_objects add column uploaded_by text;

update file_objects f
   set uploaded_by = coalesce(
     (select s.created_by from sessions s where s.tenant_id = f.tenant_id and s.id = f.session_id),
     (select w.created_by from workspaces w where w.tenant_id = f.tenant_id and w.id = f.workspace_id),
     'U00001'
   );

alter table file_objects alter column uploaded_by set not null;
alter table file_objects
  add constraint file_objects_uploaded_by_fk
  foreign key (tenant_id, uploaded_by) references users(tenant_id, id);

create table oidc_login_transactions (
  transaction_hash text primary key,
  audience text not null check (audience in ('workbench', 'admin')),
  state_hash text not null,
  code_verifier_encrypted text not null,
  nonce text not null,
  return_to text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index oidc_login_transactions_by_expiry
  on oidc_login_transactions (expires_at);

create table authentication_sessions (
  session_hash text primary key,
  tenant_id text not null references tenants(id),
  audience text not null check (audience in ('workbench', 'admin')),
  user_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz not null,
  authorization_version integer not null check (authorization_version >= 1),
  permissions jsonb not null default '[]'::jsonb,
  data_scopes jsonb not null default '[]'::jsonb,
  permissions_expires_at timestamptz not null,
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

create index authentication_sessions_by_user
  on authentication_sessions (tenant_id, user_id, audience, expires_at desc);
create index authentication_sessions_by_expiry
  on authentication_sessions (expires_at) where revoked_at is null;

insert into roles (id, tenant_id, code, name, permissions)
values
  (
    'role-department-manager', 'tenant-dsh-work', 'department_manager',
    '部门负责人', '["workbench:use", "workbench:manage"]'::jsonb
  ),
  (
    'role-auditor', 'tenant-dsh-work', 'auditor',
    '安全审计员', '["admin:read", "audit:read"]'::jsonb
  )
on conflict (id) do update
  set code = excluded.code,
      name = excluded.name,
      permissions = excluded.permissions;

update roles
   set permissions = '["admin:*", "admin:read", "admin:write", "audit:read", "workbench:use"]'::jsonb
 where tenant_id = 'tenant-dsh-work' and id = 'role-platform-admin';

insert into data_scope_grants (
  id, tenant_id, subject_type, subject_id, scope_code, scope_value
)
values
  (
    'grant-role-manager-enterprise', 'tenant-dsh-work', 'role',
    'role-department-manager', 'capability', 'enterprise:authorized'
  ),
  (
    'grant-role-manager-workspace', 'tenant-dsh-work', 'role',
    'role-department-manager', 'capability', 'workspace:authorized'
  ),
  (
    'grant-role-auditor-enterprise', 'tenant-dsh-work', 'role',
    'role-auditor', 'capability', 'enterprise:authorized'
  )
on conflict do nothing;
