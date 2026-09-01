-- Keep AI Hub managed role grants isolated by portal application.

alter table user_roles
  add column source_key text not null default 'local';

alter table user_roles
  drop constraint user_roles_pkey;

alter table user_roles
  add primary key (tenant_id, user_id, role_id, source_key);

create index user_roles_by_source
  on user_roles (tenant_id, user_id, source_key, role_id);
