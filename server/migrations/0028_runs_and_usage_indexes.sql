-- ---------------------------------------------------------------------------
-- 0028: active-run index and one-usage-row-per-attempt unique index (5-T3)
--
-- 编号说明：跳过 0027 —— 该号由并行的 admin skill installation 迁移
-- (0027_admin_skill_installation.sql) 占用；本迁移与它互不依赖。
--
-- Two pure-additive constraint gaps, no existing table/column is altered:
--   * runs only has runs_by_session (tenant_id, session_id, created_at desc)
--     (0001_m2_platform.sql). The three listActiveRuns* queries in
--     postgres-run-repository.ts (by workspace user / by agent member /
--     by whole workspace) all filter on tenant_id plus the same three
--     in-flight statuses, so a partial index serves every one of them
--     without pulling historical succeeded/failed runs in.
--   * model_usage_events has no per-attempt uniqueness beyond its primary key.
--     The writer (postgres-operations-service.ts #recordModelUsage) only relies
--     on a deterministic id `usage-<attemptId>` with `on conflict (id) do
--     nothing`, which stops a same-id replay but NOT a second row for the same
--     (tenant_id, attempt_id) under a different id. The 4-T3 adversarial review
--     reproduced exactly that: both the workspace usage aggregate and the
--     platform operations aggregate double-count it.
--
-- 去重策略：同一 (tenant_id, attempt_id) 只保留 occurred_at 最早的一行，并列时保留 id
-- 最小者，删除其余。保留最早＝最接近首次记录：一个 attempt 的用量事实只有第一次观测
-- 到的 token/状态是真实值，重复行是写入重放或竞态留下的副本；保留最新会把重放时再次
-- 估算出的值当成真实用量。判定 (occurred_at asc, id asc) 完全确定，不依赖物理顺序。
-- 去重必须先于唯一索引执行，否则索引建不起来；索引建好后重跑本文件时该语句不再匹配
-- 任何行，因此整个迁移可重复执行（replayable）。
-- ---------------------------------------------------------------------------

create index if not exists runs_active_by_tenant
  on runs (tenant_id, status)
  where status in ('queued', 'running', 'cancel_requested');

comment on index runs_active_by_tenant is
  'Partial index for the active-run lookups that filter tenant_id plus status in (queued, running, cancel_requested): listActiveRunsForWorkspaceUser and listActiveRunsInWorkspace use it directly (EXPLAIN verified). listActiveRunsForAgentMember additionally fixes a session and an agent-member row, so the planner may instead drive the scan from runs_by_session; which plan wins depends on the data shape (reviewers measured both ways at different run counts), and for it the index is harmless rather than load-bearing.';

-- Deterministic dedupe of model_usage_events per (tenant_id, attempt_id).
--
-- Keep, in order: the earliest occurred_at (closest to the first observation),
-- then a row whose tokens were REPORTED by the runtime over one the platform
-- ESTIMATED (estimated = false before true -- an estimate must never win over a
-- real report), then the smallest id as the final deterministic tie-break.
-- Adversarial review F3 showed that ordering by (occurred_at, id) alone could
-- keep the estimated row and delete the reported one when both share a timestamp.
with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, attempt_id
           order by occurred_at asc, estimated asc, id asc
         ) as duplicate_rank
    from model_usage_events
)
delete from model_usage_events
 where id in (select id from ranked where duplicate_rank > 1);

create unique index if not exists model_usage_by_attempt
  on model_usage_events (tenant_id, attempt_id);

comment on index model_usage_by_attempt is
  'At most one usage fact per attempt. The writer''s deterministic id (usage-<attemptId> + on conflict (id) do nothing) only stops a same-id replay; this index is the second line of defence and rejects a repeated attempt under a different id, which would otherwise be double-counted by the workspace usage and platform operations aggregates. 0028 deduped existing rows first, keeping the earliest occurred_at (tie-broken by smallest id) = 最接近首次记录.';
