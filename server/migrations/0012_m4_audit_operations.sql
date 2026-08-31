-- M4-08 unified, read-only operational event projection.
-- Only safe metadata is projected; message bodies, prompts and file contents are excluded.

update audit_events
   set object_type = split_part(action, '.', 1)
 where object_type = 'run'
   and split_part(action, '.', 1) in ('agent', 'skill', 'tool', 'connector', 'runtime');

create index if not exists audit_by_object_time
  on audit_events (tenant_id, object_type, occurred_at desc);
create index if not exists run_events_by_time
  on run_events (tenant_id, occurred_at desc);
create index if not exists tool_audit_by_time
  on tool_audit_logs (tenant_id, occurred_at desc);
create index if not exists artifact_versions_by_time
  on artifact_versions (tenant_id, created_at desc);

create or replace view operational_events as
select
  ae.id,
  ae.tenant_id,
  ae.occurred_at,
  case
    when ae.object_type = 'authorization' then 'security'
    else 'management'
  end as category,
  ae.action,
  ae.object_type,
  ae.object_id,
  ae.actor_type,
  ae.actor_id,
  ae.result,
  ae.trace_id,
  case when ae.object_type = 'run' then ae.object_id else null end as run_id,
  null::text as attempt_id,
  ae.safe_context
from audit_events ae

union all

select
  mu.id,
  mu.tenant_id,
  mu.occurred_at,
  'model' as category,
  'model.invoke' as action,
  'model' as object_type,
  mu.provider || '/' || mu.model as object_id,
  'user' as actor_type,
  r.requested_by as actor_id,
  mu.status as result,
  mu.trace_id,
  mu.run_id,
  mu.attempt_id,
  jsonb_build_object(
    'provider', mu.provider,
    'model', mu.model,
    'inputTokens', mu.input_tokens,
    'outputTokens', mu.output_tokens,
    'latencyMs', mu.latency_ms,
    'costAmount', mu.cost_amount,
    'costCurrency', mu.cost_currency,
    'estimated', mu.estimated
  ) as safe_context
from model_usage_events mu
join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id

union all

select
  ta.id,
  ta.tenant_id,
  ta.occurred_at,
  'tool' as category,
  'tool.permission.resolve' as action,
  'tool' as object_type,
  ta.tool_version_id as object_id,
  'user' as actor_type,
  ta.actor_user_id as actor_id,
  ta.result,
  ta.trace_id,
  ta.run_id,
  ta.attempt_id,
  ta.parameter_summary as safe_context
from tool_audit_logs ta

union all

select
  re.id,
  re.tenant_id,
  re.occurred_at,
  'run' as category,
  re.event_type as action,
  'run' as object_type,
  re.run_id as object_id,
  case when re.event_type in ('run.failed', 'run.completed', 'run.cancelled') then 'system' else 'user' end as actor_type,
  case when re.event_type in ('run.failed', 'run.completed', 'run.cancelled') then 'system' else r.requested_by end as actor_id,
  case
    when re.event_type = 'run.failed' then 'failed'
    when re.event_type = 'approval.required' then 'blocked'
    else 'success'
  end as result,
  re.trace_id,
  re.run_id,
  re.attempt_id,
  re.safe_metadata as safe_context
from run_events re
join runs r on r.tenant_id = re.tenant_id and r.id = re.run_id

union all

select
  av.id,
  av.tenant_id,
  av.created_at,
  'artifact' as category,
  'artifact.version.created' as action,
  'artifact' as object_type,
  av.artifact_id as object_id,
  'user' as actor_type,
  a.created_by as actor_id,
  'success' as result,
  coalesce(last_event.trace_id, 'trace-artifact-' || av.id) as trace_id,
  av.source_run_id as run_id,
  last_event.attempt_id,
  jsonb_build_object(
    'version', av.version_no,
    'fileObjectId', av.file_object_id,
    'artifactName', a.name,
    'artifactType', a.artifact_type
  ) as safe_context
from artifact_versions av
join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
left join lateral (
  select re.trace_id, re.attempt_id
    from run_events re
   where re.tenant_id = av.tenant_id and re.run_id = av.source_run_id
   order by re.sequence desc
   limit 1
) last_event on true;

comment on view operational_events is
  'M4-08 safe projection across management, security, run, model, tool and artifact events.';
