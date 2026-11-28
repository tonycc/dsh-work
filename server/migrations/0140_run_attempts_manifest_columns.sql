-- 统计查询按 purpose 与 agent_version_id 过滤和关联时，原先逐行解压 run_attempts.manifest
-- （TOAST 的 JSONB，p95 约 13 KB）。存为生成列后统计只读这两个短列，取值与 manifest 始终一致。
alter table run_attempts
  add column if not exists manifest_purpose text generated always as (manifest->>'purpose') stored,
  add column if not exists manifest_agent_version_id text generated always as (manifest->>'agent_version_id') stored;
