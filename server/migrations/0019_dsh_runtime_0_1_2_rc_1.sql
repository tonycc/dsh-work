-- Keep the persisted operational Runtime record aligned with the immutable
-- DSH Runtime lock shipped by this release.

update runtimes
   set runtime_version = '0.1.2-rc.1'
 where tenant_id = 'tenant-dsh-work'
   and id = 'runtime-local-01';
