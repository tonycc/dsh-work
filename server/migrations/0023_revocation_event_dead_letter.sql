-- ---------------------------------------------------------------------------
-- 0023: revocation event dead-letter
--
-- The 1A-T5 revocation sweep retries a pending event every poll until it is
-- processed. A permanently failing event (a bug or an unrecoverable payload)
-- would otherwise be retried forever and drown the logs with no terminal
-- verdict. Add a terminal 'dead_letter' state so the consumer can stop after a
-- bounded number of attempts and leave an inspectable row behind.
-- ---------------------------------------------------------------------------
alter table workspace_revocation_events
  drop constraint if exists workspace_revocation_events_status_check;

alter table workspace_revocation_events
  add constraint workspace_revocation_events_status_check
  check (status in ('pending', 'processed', 'dead_letter'));

alter table workspace_revocation_events
  add column if not exists last_error text;

comment on column workspace_revocation_events.last_error is
  'Last processing error for a dead-lettered event; null while pending/processed.';

create index if not exists workspace_revocation_events_dead_letter
  on workspace_revocation_events (tenant_id, created_at)
  where status = 'dead_letter';
