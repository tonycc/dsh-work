insert into tenants (id, name, status)
values ('tenant-dsh-work', 'dsh-work MVP 企业', 'active')
on conflict (id) do nothing;

insert into users (id, tenant_id, external_subject, display_name, department_id, status)
values
  ('U00008', 'tenant-dsh-work', 'bootstrap:platform-admin', '陈默', 'platform', 'active'),
  ('U00001', 'tenant-dsh-work', 'bootstrap:mvp-employee', '林岚', 'supply-chain', 'active')
on conflict (id) do nothing;

insert into roles (id, tenant_id, code, name, permissions)
values
  ('role-platform-admin', 'tenant-dsh-work', 'platform_admin', '平台管理员', '["admin:*"]'),
  ('role-employee', 'tenant-dsh-work', 'employee', '普通员工', '["workbench:use"]')
on conflict (id) do nothing;

insert into user_roles (tenant_id, user_id, role_id)
values
  ('tenant-dsh-work', 'U00008', 'role-platform-admin'),
  ('tenant-dsh-work', 'U00001', 'role-employee')
on conflict do nothing;

insert into credential_refs (
  id, tenant_id, backend, external_ref, status, last_verified_at, updated_by
)
values (
  'credential-deepseek-default', 'tenant-dsh-work', 'dsh-managed',
  'DEEPSEEK_API_KEY', 'configured', now(), 'U00008'
)
on conflict (id) do nothing;

insert into model_providers (
  id, tenant_id, key, name, provider_type, base_url, credential_ref_id, status
)
values (
  'provider-deepseek-official', 'tenant-dsh-work', 'deepseek-official',
  'DeepSeek 官方', 'openai-compatible', 'https://api.deepseek.com',
  'credential-deepseek-default', 'active'
)
on conflict (id) do nothing;

insert into provider_models (
  id, tenant_id, provider_id, model_key, display_name, capabilities, status
)
values (
  'model-deepseek-v4-pro', 'tenant-dsh-work', 'provider-deepseek-official',
  'deepseek-v4-pro', 'DeepSeek V4 Pro', '["text", "thinking", "tool-calling"]', 'active'
)
on conflict (id) do nothing;

insert into model_routes (
  id, tenant_id, key, name, purpose, provider_model_id, priority, enabled
)
values (
  'route-default', 'tenant-dsh-work', 'default', '平台默认模型路由',
  'default', 'model-deepseek-v4-pro', 100, true
)
on conflict (id) do nothing;
