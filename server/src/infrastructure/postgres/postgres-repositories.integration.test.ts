import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let runs: PostgresRunRepository
const suffix = randomUUID()
const agentId = `agent-m2-${suffix}`
const agentVersionId = `agent-version-m2-${suffix}`
const sessionId = `session-m2-${suffix}`

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 4 })
  await runMigrations(database)
  runs = new PostgresRunRepository(database)
  await seedRunDependencies(database)
})

after(async () => {
  await database.end()
})

test('migrations are idempotent and install the complete M2 table set', async () => {
  const results = await runMigrations(database)
  assert.equal(results.every((result) => !result.applied), true)
  const [row] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.tables
     where table_schema = 'public'
       and table_name in (
         'users', 'agents', 'agent_versions', 'workspaces', 'sessions', 'runs',
         'run_attempts', 'run_events', 'model_providers', 'provider_models',
         'model_routes', 'credential_refs', 'runtimes', 'audit_events'
       )
  `
  assert.equal(row?.count, 14)
})

test('model governance resolves the DSH default route without secret material', async () => {
  const service = new ModelGovernanceService(new PostgresModelGovernanceRepository(database))
  const providers = await service.listProviders()
  const provider = providers.find((item) => item.id === 'provider-deepseek-official')
  assert.equal(provider?.credential?.backend, 'dsh-managed')
  assert.equal(provider?.credential?.externalRef, 'DEEPSEEK_API_KEY')
  assert.equal('secret' in (provider?.credential ?? {}), false)

  const snapshot = await service.resolveRoute('default')
  assert.equal(snapshot.providerKey, 'deepseek-official')
  assert.equal(snapshot.modelKey, 'deepseek-v4-pro')
  assert.equal('secret' in snapshot, false)
})

test('run creation is idempotent and tenant-scoped', async () => {
  const input = {
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: 'm2-idempotency-001',
  }
  const first = await runs.createRun(input)
  const repeated = await runs.createRun(input)
  assert.equal(repeated.id, first.id)
  assert.equal((await runs.getRun('tenant-other', first.id)), null)
})

test('retry creates a new immutable Attempt and events are idempotent', async () => {
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId,
    requestedBy: 'U00001',
    idempotencyKey: 'm2-retry-001',
  })
  const route = await new ModelGovernanceService(new PostgresModelGovernanceRepository(database)).resolveRoute()
  const routeSnapshot = JSON.parse(JSON.stringify(route)) as JsonObject
  const first = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    manifest: { runId: run.id, version: 1 },
    manifestSha256: 'a'.repeat(64),
    modelRouteSnapshot: routeSnapshot,
  })
  await runs.transitionRun(run.tenantId, run.id, 'running')
  await runs.transitionAttempt(run.tenantId, first.id, 'running')
  await runs.transitionAttempt(run.tenantId, first.id, 'failed', 'MODEL_TIMEOUT')
  await runs.transitionRun(run.tenantId, run.id, 'failed')

  const second = await runs.createAttempt({
    tenantId: run.tenantId,
    runId: run.id,
    manifest: { runId: run.id, version: 1 },
    manifestSha256: 'a'.repeat(64),
    modelRouteSnapshot: routeSnapshot,
  })
  assert.equal(second.attemptNo, 2)
  assert.notEqual(second.id, first.id)
  assert.deepEqual(second.modelRouteSnapshot, first.modelRouteSnapshot)

  const event = {
    id: `event-m2-${suffix}-001`,
    tenantId: run.tenantId,
    runId: run.id,
    attemptId: second.id,
    sequence: 1,
    eventType: 'attempt.started',
    displayMessage: '开始执行',
    safeMetadata: { runtime: 'integration' },
    traceId: 'trace-m2-integration-001',
    occurredAt: new Date().toISOString(),
  }
  const created = await runs.appendEvent(event)
  const repeated = await runs.appendEvent(event)
  assert.equal(repeated.id, created.id)
  assert.equal((await runs.readEvents(run.tenantId, run.id)).length, 1)

  await assert.rejects(
    runs.appendEvent({ ...event, id: `event-m2-${suffix}-002` }),
    /duplicate key|unique constraint/i,
  )
})

test('published governance versions reject in-place mutation', async () => {
  await database`
    update agent_versions set status = 'published', published_at = now()
     where tenant_id = 'tenant-dsh-work' and id = ${agentVersionId}
  `
  await assert.rejects(
    database`
      update agent_versions set system_prompt = '不允许覆盖已发布版本'
       where tenant_id = 'tenant-dsh-work' and id = ${agentVersionId}
    `,
    /published versions are immutable/i,
  )
})

async function seedRunDependencies(sql: DatabaseClient) {
  await sql`
    insert into tenants (id, name, status) values ('tenant-other', '其他租户', 'active')
    on conflict (id) do nothing
  `
  await sql`
    insert into agents (
      id, tenant_id, name, description, owner_user_id, created_by, status
    ) values (
      ${agentId}, 'tenant-dsh-work', 'M2 集成 Agent', '用于验证 PostgreSQL 约束',
      'U00008', 'U00008', 'draft'
    ) on conflict (id) do nothing
  `
  await sql`
    insert into agent_versions (
      id, tenant_id, agent_id, version, system_prompt, status
    ) values (
      ${agentVersionId}, 'tenant-dsh-work', ${agentId}, '0.1.0',
      '仅用于 M2 PostgreSQL 集成测试的 System Prompt。', 'draft'
    ) on conflict (id) do nothing
  `
  await sql`
    insert into sessions (
      id, tenant_id, created_by, agent_version_id, title, status
    ) values (
      ${sessionId}, 'tenant-dsh-work', 'U00001', ${agentVersionId},
      'M2 集成 Session', 'active'
    ) on conflict (id) do nothing
  `
}
