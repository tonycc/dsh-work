-- 平台配置（docs/design/runtime-parameters-plan.md，RP-S2，6.6.2）：钉钉会话有效期、待绑定凭证有效期、
-- 每日代绑上限与接口超时改在“平台配置”中修改。四项作为一组做乐观锁，用独立修订号（updated_at 精度与凭据保存都会推进它，不适合比对）。

alter table dingtalk_app_configurations
  add column if not exists parameters_revision integer not null default 1 check (parameters_revision >= 1);
