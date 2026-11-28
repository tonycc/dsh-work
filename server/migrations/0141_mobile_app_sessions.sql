-- Android App 会话来源（移动端规划 M0）。
--
-- 原生 App 用账号密码登录后签发 `mobile-app` 会话：与桌面浏览器的密码会话、钉钉会话并存，
-- 互不撤销；同一台手机重新登录只替换这台手机上一条会话，App 内退出只撤销本机会话。
-- 修改密码、管理员重置密码与停用账号仍撤销全部来源（与 0129 之后的行为一致）。

alter table authentication_sessions
  add column if not exists device_id text,
  add column if not exists device_name text;

alter table authentication_sessions drop constraint if exists authentication_sessions_provider_check;
alter table authentication_sessions add constraint authentication_sessions_provider_check
  check (authentication_provider in ('local-password', 'dingtalk', 'mobile-app'));

alter table authentication_sessions drop constraint if exists authentication_session_credentials;
alter table authentication_sessions add constraint authentication_session_credentials check (
  (authentication_provider = 'local-password' and binding_id is null and device_id is null)
  or (authentication_provider = 'dingtalk' and binding_id is not null and device_id is null)
  or (authentication_provider = 'mobile-app' and binding_id is null and device_id is not null
      and char_length(device_id) between 1 and 128
      and (device_name is null or char_length(device_name) <= 80))
);

-- 同一台手机重新登录时按设备撤销旧会话。
create index if not exists authentication_sessions_mobile_device_idx
  on authentication_sessions (tenant_id, user_id, device_id)
  where authentication_provider = 'mobile-app' and revoked_at is null;
