-- M4-07 per-Runtime configuration history and operational indexes.

alter table runtime_configurations
  add column if not exists runtime_id text;

update runtime_configurations
   set runtime_id = 'runtime-local-01'
 where runtime_id is null;

alter table runtime_configurations
  alter column runtime_id set not null;

alter table runtime_configurations
  drop constraint runtime_configurations_pkey;

alter table runtime_configurations
  add constraint runtime_configurations_pkey primary key (tenant_id, runtime_id, revision),
  add constraint runtime_configurations_runtime_fk
    foreign key (tenant_id, runtime_id) references runtimes(tenant_id, id);

create index if not exists runtime_configurations_latest
  on runtime_configurations (tenant_id, runtime_id, revision desc);
create index if not exists run_attempts_runtime_schedule
  on run_attempts (tenant_id, runtime_id, status, created_at);
