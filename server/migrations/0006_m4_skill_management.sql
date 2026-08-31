-- M4-02 durable Skill lifecycle and immutable runtime configuration.

drop trigger if exists skill_versions_immutable on skill_versions;

alter table skills
  add column if not exists category text not null default '未分类',
  add column if not exists description text not null default '迁移的 Skill 配置',
  add column if not exists active_version_id text,
  add column if not exists draft_version_id text,
  add column if not exists created_by text,
  add column if not exists updated_at timestamptz not null default now();

update skills set created_by = owner_user_id where created_by is null;
alter table skills alter column created_by set not null;

alter table skill_versions
  add column if not exists name text not null default '未命名 Skill',
  add column if not exists category text not null default '未分类',
  add column if not exists description text not null default '迁移的 Skill 配置',
  add column if not exists tool_refs jsonb not null default '[]'::jsonb,
  add column if not exists test_prompt text not null default '请介绍这个 Skill 的能力',
  add column if not exists created_by text,
  add column if not exists published_by text,
  add column if not exists published_at timestamptz,
  add column if not exists source_version text,
  add column if not exists change_summary text not null default '迁移既有 Skill 版本';

update skill_versions sv
   set name = s.name,
       category = s.category,
       description = s.description,
       created_by = s.owner_user_id,
       published_at = case when sv.status = 'published' then coalesce(sv.published_at, sv.created_at) else sv.published_at end,
       published_by = case when sv.status = 'published' then coalesce(sv.published_by, s.owner_user_id) else sv.published_by end
  from skills s
 where s.tenant_id = sv.tenant_id and s.id = sv.skill_id and sv.created_by is null;

alter table skill_versions alter column created_by set not null;

insert into skills (
  id, tenant_id, key, name, category, description, owner_user_id, created_by,
  status, active_version_id, draft_version_id
) values (
  'skill-document', 'tenant-dsh-work', 'document-processing', '文档处理', '文件',
  '整理企业文档，提炼关键事实、风险、行动项和责任人。',
  'U00008', 'U00008', 'published', 'skill-version-document-1', null
)
on conflict (id) do nothing;

insert into skill_versions (
  id, tenant_id, skill_id, version, name, category, description, instructions,
  manifest, tool_refs, test_prompt, status, created_by, published_by, published_at,
  change_summary
) values (
  'skill-version-document-1', 'tenant-dsh-work', 'skill-document', '1.0.0',
  '文档处理', '文件', '整理企业文档，提炼关键事实、风险、行动项和责任人。',
  '先识别文档类型和用户目标，再提取事实、结论、风险与行动项；不得虚构文档中不存在的信息，并在输出中明确区分原文事实与分析建议。',
  '{}', '["read@1.0.0"]', '请整理这份业务材料并列出行动项。',
  'published', 'U00008', 'U00008', now(), 'M4-02 预置基础 Skill'
)
on conflict (id) do nothing;

update skills s
   set active_version_id = (
     select sv.id from skill_versions sv
      where sv.tenant_id = s.tenant_id and sv.skill_id = s.id and sv.status = 'published'
      order by sv.created_at desc limit 1
   )
 where s.active_version_id is null
   and exists (
     select 1 from skill_versions sv
      where sv.tenant_id = s.tenant_id and sv.skill_id = s.id and sv.status = 'published'
   );

update skills s
   set draft_version_id = (
     select sv.id from skill_versions sv
      where sv.tenant_id = s.tenant_id and sv.skill_id = s.id and sv.status = 'draft'
      order by sv.created_at desc limit 1
   )
 where s.draft_version_id is null
   and exists (
     select 1 from skill_versions sv
      where sv.tenant_id = s.tenant_id and sv.skill_id = s.id and sv.status = 'draft'
   );

alter table skills
  add constraint skills_active_version_fk foreign key (tenant_id, active_version_id) references skill_versions(tenant_id, id),
  add constraint skills_draft_version_fk foreign key (tenant_id, draft_version_id) references skill_versions(tenant_id, id),
  add constraint skills_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id);

alter table skill_versions
  add constraint skill_versions_created_by_fk foreign key (tenant_id, created_by) references users(tenant_id, id),
  add constraint skill_versions_published_by_fk foreign key (tenant_id, published_by) references users(tenant_id, id);

create table skill_test_runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  skill_id text not null,
  skill_version_id text not null,
  configuration_fingerprint text not null,
  test_prompt text not null,
  status text not null check (status in ('passed', 'failed')),
  result_summary text not null,
  tested_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, skill_id) references skills(tenant_id, id),
  foreign key (tenant_id, skill_version_id) references skill_versions(tenant_id, id),
  foreign key (tenant_id, tested_by) references users(tenant_id, id)
);

create index skill_test_runs_by_version
  on skill_test_runs (tenant_id, skill_version_id, created_at desc);

create table skill_release_records (
  id text primary key,
  tenant_id text not null references tenants(id),
  skill_id text not null,
  skill_version_id text not null,
  action text not null check (action in ('published', 'enabled', 'disabled', 'rollback')),
  actor_id text not null,
  note text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, skill_id) references skills(tenant_id, id),
  foreign key (tenant_id, skill_version_id) references skill_versions(tenant_id, id),
  foreign key (tenant_id, actor_id) references users(tenant_id, id)
);

create index skill_release_records_by_skill
  on skill_release_records (tenant_id, skill_id, created_at desc);

create trigger skill_versions_immutable before update or delete on skill_versions
  for each row execute function prevent_published_version_update();
