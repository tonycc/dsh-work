-- 团队空间会话流（TW-10）活动查询按会话取 max(runs.updated_at)。runs_by_session 按 created_at 排序，
-- 每个会话都要扫完全部 Run；按 updated_at 建索引后变为每会话一次索引首行读取
-- （2000 会话 × 100 Run 实测单次 58ms → 9ms，见 docs/design/architecture-audit-baseline-2026-11-28.md）。
create index if not exists runs_by_session_updated on runs (tenant_id, session_id, updated_at desc);
