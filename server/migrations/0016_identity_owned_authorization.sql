-- AI Hub supplies identity and employee profile data; dsh-work owns authorization.

alter table users
  add column identity_provider text not null default 'local'
    check (identity_provider in ('local', 'ai-hub')),
  add column external_user_id text,
  add column email text,
  add column identity_updated_at timestamptz,
  add column directory_synced_at timestamptz,
  add column local_authorization_version bigint not null default 1
    check (local_authorization_version >= 1);

update users u
   set identity_provider = 'ai-hub',
       external_user_id = u.id,
       directory_synced_at = now()
 where exists (
   select 1 from authentication_sessions s
    where s.tenant_id = u.tenant_id and s.user_id = u.id
 ) or exists (
   select 1 from user_roles ur
    where ur.tenant_id = u.tenant_id and ur.user_id = u.id
      and ur.source_key like 'ai-hub:%'
 );

create unique index users_external_identity_unique
  on users (tenant_id, identity_provider, external_user_id)
  where external_user_id is not null;

alter table roles
  add column description text not null default '',
  add column status text not null default 'active'
    check (status in ('active', 'disabled')),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

alter table user_roles
  add column granted_by text,
  add column granted_at timestamptz not null default now();

alter table data_scope_grants
  add column granted_by text,
  add column created_at timestamptz not null default now();

create table application_admin_bootstrap_claims (
  application_id text not null,
  environment text not null,
  external_user_id text not null,
  user_id text not null,
  consumed_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (application_id, environment),
  foreign key (user_id) references users(id)
);

create table identity_directory_sync_state (
  application_id text not null,
  environment text not null,
  cursor text,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  status text not null default 'idle'
    check (status in ('idle', 'running', 'failed')),
  run_id text,
  synchronized_users bigint not null default 0 check (synchronized_users >= 0),
  updated_at timestamptz not null default now(),
  primary key (application_id, environment)
);

-- Remove the retired external authorization projection. Existing users and
-- their audit history remain; only grants derived from AI Hub are removed.
delete from user_roles where source_key like 'ai-hub:%';
delete from data_scope_grants where scope_code like 'ai-hub:%';

alter table user_roles
  add constraint user_roles_local_source_check check (source_key = 'local');

update authentication_sessions s
   set authorization_version = u.local_authorization_version,
       permissions = '[]'::jsonb,
       data_scopes = '[]'::jsonb,
       permissions_expires_at = s.expires_at
  from users u
 where u.tenant_id = s.tenant_id and u.id = s.user_id;

create or replace function bump_user_local_authorization_version()
returns trigger language plpgsql as $$
declare
  affected_user_id text;
  affected_tenant text;
begin
  if tg_op = 'DELETE' then
    affected_user_id := old.user_id;
    affected_tenant := old.tenant_id;
  else
    affected_user_id := new.user_id;
    affected_tenant := new.tenant_id;
  end if;
  update users
     set local_authorization_version = local_authorization_version + 1,
         updated_at = now()
   where tenant_id = affected_tenant
     and id = affected_user_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger user_roles_bump_local_authorization
after insert or update or delete on user_roles
for each row execute function bump_user_local_authorization_version();

create or replace function bump_scope_local_authorization_version()
returns trigger language plpgsql as $$
declare
  subject_kind text;
  subject_value text;
  affected_tenant text;
begin
  if tg_op = 'DELETE' then
    subject_kind := old.subject_type;
    subject_value := old.subject_id;
    affected_tenant := old.tenant_id;
  else
    subject_kind := new.subject_type;
    subject_value := new.subject_id;
    affected_tenant := new.tenant_id;
  end if;
  if subject_kind = 'user' then
    update users
       set local_authorization_version = local_authorization_version + 1,
           updated_at = now()
     where tenant_id = affected_tenant and id = subject_value;
  elsif subject_kind = 'role' then
    update users u
       set local_authorization_version = u.local_authorization_version + 1,
           updated_at = now()
      from user_roles ur
     where ur.tenant_id = affected_tenant
       and ur.role_id = subject_value
       and u.tenant_id = ur.tenant_id
       and u.id = ur.user_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger data_scope_grants_bump_local_authorization
after insert or update or delete on data_scope_grants
for each row execute function bump_scope_local_authorization_version();

create or replace function bump_role_local_authorization_version()
returns trigger language plpgsql as $$
begin
  if old.permissions is distinct from new.permissions
     or old.status is distinct from new.status then
    update users u
       set local_authorization_version = u.local_authorization_version + 1,
           updated_at = now()
      from user_roles ur
     where ur.tenant_id = new.tenant_id
       and ur.role_id = new.id
       and u.tenant_id = ur.tenant_id
       and u.id = ur.user_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger roles_bump_local_authorization
before update on roles
for each row execute function bump_role_local_authorization_version();
