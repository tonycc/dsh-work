-- ---------------------------------------------------------------------------
-- 0025: logical workspace files and versions (batch 3 / 3-T6 / TW-07)
--
-- file_objects stays immutable (P0, AC-13): it keeps the bytes, the parse
-- result and every historical run_input_files reference. TW-07 only adds a
-- 「逻辑文件 → 版本」 layer on top, so a new upload never overwrites an object
-- that a historical run already consumed.
--
-- Personal-space files and session attachments are deliberately NOT part of
-- this model (AC-23 / 方案 §6.4): only team shared files (session_id is null)
-- get a logical file. Personal files keep their existing path.
-- ---------------------------------------------------------------------------

create table if not exists workspace_files (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  name text not null,
  status text not null default 'active' check (status in ('active', 'removed')),
  latest_version_no integer not null default 0 check (latest_version_no >= 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by text,
  unique (tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

comment on table workspace_files is
  'Logical team workspace file. One row groups every immutable file_objects version of the same shared file. Personal files and session attachments never get a row here.';

comment on column workspace_files.name is
  'Editable display name, independent of each version''s original file name.';

comment on column workspace_files.status is
  'active = referenceable; removed = logically removed (every version object and historical reference is retained).';

comment on column workspace_files.latest_version_no is
  'Highest version_no that is scan-clean AND parsed successfully. Advanced only after the new object passed both gates; 0 means no usable version exists yet, so the file is absent from the effective list.';

comment on column workspace_files.updated_at is
  'Last version upload or logical removal time.';

create table if not exists workspace_file_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  logical_file_id text not null,
  version_no integer not null check (version_no > 0),
  file_object_id text not null,
  note text,
  parse_status text not null default 'pending' check (parse_status in ('pending', 'succeeded', 'failed')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, logical_file_id, version_no),
  unique (tenant_id, file_object_id),
  foreign key (tenant_id, logical_file_id) references workspace_files(tenant_id, id),
  foreign key (tenant_id, file_object_id) references file_objects(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

comment on table workspace_file_versions is
  'Immutable file object pinned to one logical file version. run_input_files keeps pointing at file_object_id, so the version actually used by a historical run is traceable through this table.';

comment on column workspace_file_versions.file_object_id is
  'The immutable file_objects row. Unique per tenant: an object belongs to exactly one version and is never re-pointed.';

comment on column workspace_file_versions.note is
  'Optional upload note attached by the uploader.';

comment on column workspace_file_versions.parse_status is
  'pending = object stored, extraction not finished; succeeded/failed record the outcome. failed versions are kept for traceability but never advance workspace_files.latest_version_no.';

-- 有效逻辑文件按空间列出，版本对象提供排序键；部分索引避免扫到已移除的逻辑文件。
create index if not exists workspace_files_active_by_workspace
  on workspace_files (tenant_id, workspace_id, updated_at desc)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- Backfill: every existing team workspace shared file becomes version 1 of its
-- own logical file. Personal-space files (w.workspace_type = 'personal') and
-- session attachments (f.session_id is not null) are intentionally skipped.
-- Logically removed files (f.removed_at is not null) stay out of the effective
-- list, matching the pre-TW-07 list semantics.
-- ---------------------------------------------------------------------------
insert into workspace_files (
  id, tenant_id, workspace_id, name, status, latest_version_no, created_by, created_at, updated_at
)
select 'wfile-' || f.id, f.tenant_id, f.workspace_id, f.original_name, 'active', 1,
       f.uploaded_by, f.created_at, f.created_at
  from file_objects f
  join workspaces w on w.tenant_id = f.tenant_id and w.id = f.workspace_id
 where f.session_id is null
   and f.removed_at is null
   and w.workspace_type = 'team'
   -- 已经属于某个版本行的对象不再新建逻辑文件：重放时若只按主键兜底，会为一个
   -- 已有版本的对象插出一条零版本行的孤儿逻辑文件（第二轮验证 P3-1）。
   and not exists (
     select 1 from workspace_file_versions v
      where v.tenant_id = f.tenant_id and v.file_object_id = f.id
   )
-- 主键由对象 id 确定性派生（wfile-<objectId>），按主键兜底即可幂等。
on conflict (id) do nothing;

insert into workspace_file_versions (
  id, tenant_id, logical_file_id, version_no, file_object_id, note, parse_status, created_by, created_at
)
select 'wfv-' || f.id, f.tenant_id, 'wfile-' || f.id, 1, f.id, null,
       case
         when exists (
           select 1 from file_extractions fe
            where fe.tenant_id = f.tenant_id and fe.file_id = f.id
              and fe.extractor_version = 'm4-basic-v1' and fe.status = 'succeeded'
         ) then 'succeeded'
         when exists (
           select 1 from file_extractions fe
            where fe.tenant_id = f.tenant_id and fe.file_id = f.id and fe.status = 'failed'
         ) then 'failed'
         else 'pending'
       end,
       f.uploaded_by, f.created_at
  from file_objects f
  join workspaces w on w.tenant_id = f.tenant_id and w.id = f.workspace_id
 where f.session_id is null
   and f.removed_at is null
   and w.workspace_type = 'team'
-- 版本行的业务唯一键是 (tenant_id, file_object_id)：重跑时逻辑文件 id 前缀相同，
-- 但按主键捕获不到「同一对象已存在版本行」的情形，会命中该唯一约束并让整个迁移回滚。
on conflict (tenant_id, file_object_id) do nothing;

-- 回填的版本记录若解析未成功（历史失败/未解析对象），不给它有效版本号；这类逻辑
-- 文件与旧列表行为一致地不出现在「最新有效版本」里，但记录仍在（可追溯）。
update workspace_files wf
   set latest_version_no = 0
 where not exists (
   select 1 from workspace_file_versions wfv
    where wfv.tenant_id = wf.tenant_id and wfv.logical_file_id = wf.id
      and wfv.parse_status = 'succeeded'
 );
