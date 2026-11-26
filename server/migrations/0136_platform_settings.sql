-- 运行参数（docs/design/runtime-parameters-plan.md，RP-S1，RP2）：页面保存过的平台参数。
-- 键、所属模块、默认值、范围与保存权限只在代码登记表（server/src/domain/platform-settings.ts）中定义；
-- 这里只存保存过的值。没有记录、或值为 JSON null（恢复默认后保留该行，版本号继续递增）的键按登记表默认值生效。

create table if not exists platform_settings (
  tenant_id text not null references tenants(id),
  key text not null check (char_length(key) between 1 and 120),
  value jsonb not null,
  revision integer not null default 1 check (revision >= 1),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);
