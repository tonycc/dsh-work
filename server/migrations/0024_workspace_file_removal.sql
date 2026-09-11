-- ---------------------------------------------------------------------------
-- 0024: logical removal for shared workspace files (1B-T3 / 设计 §2.3)
--
-- 共享文件的「移除」是逻辑移除：文件对象、解析结果与历史 Run 的引用都保留，
-- 只让它在「可引用」集合中消失。物理删除会破坏历史 Run 的可追溯性（AC-13）。
-- 不新增版本表：逻辑文件与版本关系属 P1（TW-07），本批不做。
-- ---------------------------------------------------------------------------
alter table file_objects
  add column if not exists removed_at timestamptz;

alter table file_objects
  add column if not exists removed_by text;

comment on column file_objects.removed_at is
  'Logical removal time for shared workspace files; null means still referenceable. Historical runs keep their references.';

comment on column file_objects.removed_by is
  'Actor that removed the file logically.';

-- 有效文件列表按空间过滤并排除已移除项，按时间倒序分页。
create index if not exists file_objects_workspace_active
  on file_objects (tenant_id, workspace_id, created_at desc)
  where removed_at is null;
