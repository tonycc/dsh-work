-- M4-04 controlled knowledge catalog. Seed content is synthetic and replaceable;
-- it validates versioning, permission filtering, Runtime context and citations.

create table knowledge_sources (
  id text primary key,
  tenant_id text not null references tenants(id),
  key text not null,
  name text not null,
  source_type text not null check (source_type in ('managed-catalog', 'external-api')),
  description text not null,
  status text not null check (status in ('active', 'disabled')),
  synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key)
);

create table knowledge_documents (
  id text primary key,
  tenant_id text not null references tenants(id),
  source_id text not null,
  document_key text not null,
  title text not null,
  version text not null,
  effective_date date not null,
  content text not null,
  content_checksum text not null,
  keywords jsonb not null default '[]'::jsonb,
  allowed_role_ids jsonb not null default '[]'::jsonb,
  allowed_workspace_ids jsonb not null default '[]'::jsonb,
  data_scope text not null,
  status text not null check (status in ('draft', 'published', 'retired')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, source_id, document_key, version),
  foreign key (tenant_id, source_id) references knowledge_sources(tenant_id, id)
);

create table run_knowledge_sources (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  document_id text not null,
  relevance_score integer not null check (relevance_score > 0),
  excerpt text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, document_id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, document_id) references knowledge_documents(tenant_id, id)
);

create index knowledge_documents_by_source
  on knowledge_documents (tenant_id, source_id, status, effective_date desc);
create index run_knowledge_sources_by_run
  on run_knowledge_sources (tenant_id, run_id, created_at);

create trigger knowledge_documents_immutable before update or delete on knowledge_documents
  for each row execute function prevent_published_version_update();

insert into knowledge_sources (
  id, tenant_id, key, name, source_type, description, status, synthetic
) values (
  'knowledge-source-managed-mvp', 'tenant-dsh-work', 'managed-mvp-catalog',
  'MVP 受控知识目录', 'managed-catalog',
  '用于验证版本、权限、引用和 Runtime 注入的可替换知识源；当前文档均为合成测试数据。',
  'active', true
)
on conflict (id) do nothing;

with documents (
  id, document_key, title, version, effective_date, content, keywords,
  allowed_role_ids, allowed_workspace_ids, data_scope
) as (values
  (
    'knowledge-supply-exception-v32', 'supply-exception-policy',
    '供应链异常管理办法', '3.2', date '2026-06-01',
    '本办法为合成测试制度。供应链异常分为三级：一级为可能导致客户停线或关键订单延期超过五个工作日的重大异常；二级为可能造成订单延期二至五个工作日的重点异常；三级为可在两个工作日内闭环的一般异常。发现一级异常后，责任人应在两小时内登记事实、影响订单、预计恢复时间和临时措施，并在四小时内升级至供应链负责人。所有异常结论必须附订单、库存或工单证据；证据不足时只能标记为待核实，不得推断为已解决。异常关闭前应记录根因、纠正措施、责任人、计划日期和验证结果。',
    '["供应链", "异常", "延期", "升级", "闭环", "订单", "客户停线"]'::jsonb,
    '["role-employee"]'::jsonb, '[]'::jsonb, 'domain:supply-chain'
  ),
  (
    'knowledge-inventory-policy-v21', 'inventory-safety-policy',
    '库存安全水位管理规范', '2.1', date '2026-03-15',
    '本规范为合成测试制度。可用库存按在库数量减去已分配数量计算。物料可用库存低于安全库存时进入预警；低于安全库存百分之五十时升级为高风险。分析库存风险时必须同时列出在库、已分配、安全库存、在途数量和预计到货日期，任何字段缺失均应明确标记。补货建议应参考采购提前期和已确认需求，不得仅依据单日库存生成确定性结论。高风险物料由工作空间负责人确认处置优先级，涉及供应商交期变更时需保留采购订单或书面确认记录。',
    '["库存", "安全水位", "安全库存", "可用库存", "补货", "物料", "在途"]'::jsonb,
    '["role-employee"]'::jsonb, '["ws-supply"]'::jsonb, 'domain:supply-chain'
  )
)
insert into knowledge_documents (
  id, tenant_id, source_id, document_key, title, version, effective_date,
  content, content_checksum, keywords, allowed_role_ids, allowed_workspace_ids,
  data_scope, status, published_at
)
select id, 'tenant-dsh-work', 'knowledge-source-managed-mvp', document_key,
       title, version, effective_date, content, md5(content), keywords,
       allowed_role_ids, allowed_workspace_ids, data_scope, 'published', now()
  from documents
on conflict (id) do nothing;
