-- 模型路由方案 MR-S1（docs/design/model-routing-plan.md 4.3、4.8、4.9）：治理数据补强，不改变执行行为。
-- 1. provider_type 由自由文本改为枚举，全部经 DSH pi-ai 接入；历史上的 openai-compatible、deepseek-official
--    等取值都是 OpenAI 兼容协议，统一迁移为 openai-completions（R4：DeepSeek 统一以 openai-completions 接入）。
-- 2. Provider 增加信任级别 trust_level（internal 内部部署 / external 外部厂商），供数据防护按级别处理；
--    存量一律视为 external，由管理员确认后改为 internal。
-- 3. 路由用途只保留 default（R2）：chat、analysis、fallback 路由先停用再改为 default，避免触发
--    “每租户一条启用的默认路由”唯一索引；由管理员确认后删除。
update model_providers
   set provider_type = 'openai-completions', updated_at = now()
 where provider_type not in ('openai-completions', 'openai-responses', 'anthropic-messages');

alter table model_providers
  add constraint model_providers_provider_type_check
  check (provider_type in ('openai-completions', 'openai-responses', 'anthropic-messages'));

alter table model_providers add column trust_level text not null default 'external';
alter table model_providers alter column trust_level drop default;
alter table model_providers
  add constraint model_providers_trust_level_check
  check (trust_level in ('internal', 'external'));

update model_routes
   set enabled = false, updated_at = now()
 where purpose <> 'default' and enabled;

update model_routes
   set purpose = 'default', updated_at = now()
 where purpose <> 'default';

alter table model_routes drop constraint if exists model_routes_purpose_check;
alter table model_routes
  add constraint model_routes_purpose_check
  check (purpose = 'default');
