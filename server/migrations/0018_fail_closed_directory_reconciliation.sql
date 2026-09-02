-- Existing installations may have applied 0017 while business users defaulted
-- to true.  Fail closed until AI Hub performs the next authoritative directory
-- reconciliation, and force that reconciliation to restart from the beginning.

alter table users
  alter column business_user set default false;

update users
   set business_user = false,
       status = 'disabled',
       local_authorization_version = local_authorization_version + 1,
       updated_at = now()
 where identity_provider = 'ai-hub';

update identity_directory_sync_state
   set cursor = null,
       status = 'idle',
       run_id = null,
       last_error = null,
       updated_at = now();
