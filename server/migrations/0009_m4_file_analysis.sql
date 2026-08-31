-- M4-05 immutable document extraction and per-Attempt input snapshot.

create table file_extractions (
  id text primary key,
  tenant_id text not null references tenants(id),
  file_id text not null,
  extractor_version text not null,
  detected_type text not null check (detected_type in ('pdf', 'docx', 'xlsx', 'csv', 'text')),
  status text not null check (status in ('succeeded', 'failed')),
  text_storage_key text,
  text_sha256 text,
  character_count integer,
  page_count integer,
  sheet_count integer,
  row_count integer,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, file_id, extractor_version),
  foreign key (tenant_id, file_id) references file_objects(tenant_id, id),
  check (
    (status = 'succeeded' and text_storage_key is not null and text_sha256 is not null and character_count is not null and error_code is null)
    or (status = 'failed' and text_storage_key is null and text_sha256 is null and character_count is null and error_code is not null)
  )
);

create table run_input_files (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  file_id text not null,
  extraction_id text not null,
  mount_path text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, attempt_id, file_id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, file_id) references file_objects(tenant_id, id),
  foreign key (tenant_id, extraction_id) references file_extractions(tenant_id, id)
);

create index file_extractions_by_file
  on file_extractions (tenant_id, file_id, created_at desc);
create index run_input_files_by_run
  on run_input_files (tenant_id, run_id, attempt_id);
