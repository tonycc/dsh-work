-- 模型用量改用模型网关计量（模型路由方案 4.6、MR-S3；模型用量页改版）。
--
-- 运行结束时按网关逐次请求记录汇总用量：对话与联网搜索各写一行（endpoint），记录实际模型、
-- 请求次数（含重试）、失败次数与缓存读写 token。没有网关记录时（网关上线前的运行、测试替身）
-- 沿用 DSH 会话日志或按文本长度估算，measurement 说明来源；estimated 与之保持一致，供旧读者使用。
--
-- 缓存字段为 null 表示厂商未返回（不记为 0，避免把“未知”统计成“未命中”）。
-- 输入、输出 token 保持非空：网关上没有任何请求返回用量时记 0（被中止的流式请求会少计）。

alter table model_usage_events
  add column if not exists endpoint text not null default 'chat'
    check (endpoint in ('chat', 'search')),
  add column if not exists measurement text not null default 'estimated'
    check (measurement in ('gateway', 'session-log', 'estimated')),
  add column if not exists cache_read_tokens bigint
    check (cache_read_tokens is null or cache_read_tokens >= 0),
  add column if not exists cache_write_tokens bigint
    check (cache_write_tokens is null or cache_write_tokens >= 0),
  add column if not exists request_count integer
    check (request_count is null or request_count >= 0),
  add column if not exists failed_request_count integer
    check (failed_request_count is null or failed_request_count >= 0);

-- 既有记录：非估算的都来自 DSH 会话日志。
update model_usage_events set measurement = 'session-log' where not estimated;

-- 取消的运行也记录已在网关上发生的消耗。
alter table model_usage_events drop constraint if exists model_usage_events_status_check;
alter table model_usage_events add constraint model_usage_events_status_check
  check (status in ('success', 'failed', 'blocked', 'cancelled'));

-- 每个 Attempt 每种请求类型至多一行（对话一行、联网搜索一行）。
drop index if exists model_usage_by_attempt;
create unique index if not exists model_usage_by_attempt_endpoint
  on model_usage_events (tenant_id, attempt_id, endpoint);

comment on index model_usage_by_attempt_endpoint is
  'At most one usage fact per attempt and endpoint (chat, search). The writer''s deterministic ids (usage-<attemptId>, usage-<attemptId>-search) plus on conflict (id) do nothing stop replays; this index rejects a repeated attempt under a different id. Aggregates that count executions use count(distinct attempt_id).';

-- 模型用量页按时间范围查询。
create index if not exists model_usage_by_time
  on model_usage_events (tenant_id, occurred_at desc);
