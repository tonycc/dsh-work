-- run_events_by_run_stream 与唯一约束 run_events_stream_position_unique 同列同序
-- (tenant_id, run_id, stream_position)，每次写事件都白白多维护一棵 B-Tree。
-- 唯一约束的索引已覆盖全部按 Run 读取游标的查询。
drop index if exists run_events_by_run_stream;
