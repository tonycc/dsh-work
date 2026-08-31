-- M5 personal workspace ownership: every conversation and its content belongs to one workspace.

alter table workspaces
  drop constraint if exists workspaces_workspace_type_check;

alter table workspaces
  add constraint workspaces_workspace_type_check
  check (workspace_type in ('personal', 'team'));

alter table workspaces
  add constraint personal_workspaces_stay_active
  check (workspace_type <> 'personal' or status = 'active');

create unique index if not exists one_personal_workspace_per_user
  on workspaces (tenant_id, created_by)
  where workspace_type = 'personal';

insert into workspaces (
  id, tenant_id, name, description, workspace_type, created_by, status
)
select 'ws-personal-' || u.id, u.tenant_id, '我的空间',
       '仅你可访问的默认工作空间，用于归档个人对话、文件和成果。',
       'personal', u.id, 'active'
  from users u
on conflict do nothing;

insert into workspace_members (
  tenant_id, workspace_id, user_id, member_role, added_by
)
select w.tenant_id, w.id, w.created_by, 'owner', w.created_by
  from workspaces w
 where w.workspace_type = 'personal'
on conflict (tenant_id, workspace_id, user_id) do update
  set member_role = 'owner', added_by = excluded.added_by;

update sessions s
   set workspace_id = w.id
  from workspaces w
 where s.workspace_id is null
   and w.tenant_id = s.tenant_id
   and w.workspace_type = 'personal'
   and w.created_by = s.created_by;

update file_objects f
   set workspace_id = s.workspace_id
  from sessions s
 where f.workspace_id is null
   and f.tenant_id = s.tenant_id
   and f.session_id = s.id;

update artifacts a
   set workspace_id = s.workspace_id
  from sessions s
 where a.workspace_id is null
   and a.tenant_id = s.tenant_id
   and a.session_id = s.id;

alter table sessions
  alter column workspace_id set not null;

alter table file_objects
  alter column workspace_id set not null;

alter table artifacts
  alter column workspace_id set not null;

create or replace function ensure_user_personal_workspace()
returns trigger language plpgsql as $$
declare
  personal_workspace_id text;
begin
  if new.status <> 'active' then
    return new;
  end if;

  personal_workspace_id := 'ws-personal-' || new.id;
  insert into workspaces (
    id, tenant_id, name, description, workspace_type, created_by, status
  ) values (
    personal_workspace_id, new.tenant_id, '我的空间',
    '仅你可访问的默认工作空间，用于归档个人对话、文件和成果。',
    'personal', new.id, 'active'
  ) on conflict do nothing;

  select id into personal_workspace_id
    from workspaces
   where tenant_id = new.tenant_id and workspace_type = 'personal'
     and created_by = new.id
   limit 1;

  insert into workspace_members (
    tenant_id, workspace_id, user_id, member_role, added_by
  ) values (
    new.tenant_id, personal_workspace_id, new.id, 'owner', new.id
  ) on conflict (tenant_id, workspace_id, user_id) do update
    set member_role = 'owner', added_by = excluded.added_by;
  return new;
end;
$$;

drop trigger if exists users_personal_workspace_provisioning on users;
create trigger users_personal_workspace_provisioning
  after insert or update of status on users
  for each row execute function ensure_user_personal_workspace();

create or replace function protect_personal_workspace_membership()
returns trigger language plpgsql as $$
declare
  target_workspace_id text;
  personal_owner_id text;
  target_workspace_type text;
begin
  target_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  select workspace_type, created_by
    into target_workspace_type, personal_owner_id
    from workspaces
   where tenant_id = case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end
     and id = target_workspace_id;

  if target_workspace_type = 'personal' then
    if tg_op = 'DELETE' then
      raise exception 'personal workspace owner membership cannot be removed';
    end if;
    if new.user_id <> personal_owner_id or new.member_role <> 'owner' then
      raise exception 'personal workspace can only contain its owner';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists personal_workspace_membership_guard on workspace_members;
create trigger personal_workspace_membership_guard
  before insert or update or delete on workspace_members
  for each row execute function protect_personal_workspace_membership();
