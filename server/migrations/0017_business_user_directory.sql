-- Keep AI Hub platform accounts out of the business employee directory while
-- retaining their local identity and authorization history for audit.

alter table users
  add column business_user boolean not null default false;

create index users_business_directory
  on users (tenant_id, status, display_name, id)
  where identity_provider = 'ai-hub' and business_user;
