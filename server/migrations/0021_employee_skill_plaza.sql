-- Employee Skill plaza sessions keep the exact published Skill Version selected at creation time.
alter table sessions
  add column selected_skill_version_id text;

alter table sessions
  add constraint sessions_selected_skill_version_fk
  foreign key (tenant_id, selected_skill_version_id)
  references skill_versions(tenant_id, id);

create index sessions_selected_skill_version_idx
  on sessions (tenant_id, selected_skill_version_id)
  where selected_skill_version_id is not null;
