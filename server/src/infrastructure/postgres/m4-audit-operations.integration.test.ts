import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { createDatabase, type DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let operations: PostgresOperationsService
let runId = ''
let attemptId = ''

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 4 })
  await runMigrations(database)
  operations = new PostgresOperationsService(database)

  const conversations = new PostgresConversationRepository(database)
  const runs = new PostgresRunRepository(database)
  const session = await conversations.createSession({
    userId: 'U00001',
    title: 'M4 审计运营验证',
    workspaceId: 'ws-supply',
    agentVersionId: 'agent-version-dsh-work-assistant-1',
  })
  const run = await runs.createRun({
    tenantId: 'tenant-dsh-work',
    sessionId: session.id,
    requestedBy: 'U00001',
    idempotencyKey: randomUUID(),
  })
  runId = run.id
  attemptId = `attempt-audit-${randomUUID()}`
  await runs.createAttempt({
    attemptId,
    tenantId: 'tenant-dsh-work',
    runId,
    runtimeId: 'runtime-local-01',
    manifest: {},
    manifestSha256: randomUUID().replaceAll('-', ''),
    modelRouteSnapshot: { providerKey: 'dsh-default', modelKey: 'dsh-default' },
  })

  await database`
    insert into run_events (
      id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
      safe_metadata, trace_id, occurred_at
    ) values (
      ${`event-${randomUUID()}`}, 'tenant-dsh-work', ${runId}, ${attemptId}, 1,
      'run.failed', '不得进入运营投影的回答正文',
      ${database.json({ error_code: 'SYNTHETIC_FAILURE' })}, ${`trace-${runId}`}, now()
    )
  `
  await database`
    insert into model_usage_events (
      id, tenant_id, run_id, attempt_id, provider, model, input_tokens, output_tokens,
      latency_ms, cost_amount, cost_currency, status, trace_id, estimated, occurred_at
    ) values (
      ${`usage-${randomUUID()}`}, 'tenant-dsh-work', ${runId}, ${attemptId},
      'dsh-default', 'dsh-default', 12, 8, 120, 0, 'CNY', 'failed',
      ${`trace-${runId}`}, true, now()
    )
  `
  await operations.recordToolAudit({
    runId,
    attemptId,
    traceId: `trace-${runId}`,
    metadata: { tool_name: 'read', parameter_kind: 'workspace_path' },
    result: 'blocked',
  })

  const fileId = `file-audit-${randomUUID()}`
  const artifactId = `artifact-audit-${randomUUID()}`
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name,
      mime_type, size_bytes, sha256, scan_status
    ) values (
      ${fileId}, 'tenant-dsh-work', 'ws-supply', ${session.id}, ${`audit/${fileId}`},
      '运营验证.txt', 'text/plain', 16, ${randomUUID().replaceAll('-', '')}, 'clean'
    )
  `
  await database`
    insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
    values (${artifactId}, 'tenant-dsh-work', 'ws-supply', ${session.id}, '运营验证成果', 'text', 'U00001')
  `
  await database`
    insert into artifact_versions (
      id, tenant_id, artifact_id, version_no, file_object_id, source_run_id
    ) values (
      ${`artifact-version-${randomUUID()}`}, 'tenant-dsh-work', ${artifactId}, 1, ${fileId}, ${runId}
    )
  `
  await runs.transitionAttempt('tenant-dsh-work', attemptId, 'failed', 'SYNTHETIC_FAILURE')
  await runs.transitionRun('tenant-dsh-work', runId, 'failed')
})

after(async () => {
  if (database) await database.end()
})

test('unified operations projection includes every MVP event source without content bodies', async () => {
  await operations.appendAudit(
    'U00008',
    'agent.configuration.update',
    'agent-dsh-work-assistant',
    'success',
    'trace-agent-audit-test',
    '仅允许安全配置摘要',
  )

  const events = await operations.getAuditEvents()
  const categories = new Set(events.map((event) => event.category))
  assert.ok(categories.has('management'))
  assert.ok(categories.has('run'))
  assert.ok(categories.has('model'))
  assert.ok(categories.has('tool'))
  assert.ok(categories.has('artifact'))

  const agentEvent = events.find((event) => event.action === 'agent.configuration.update')
  assert.equal(agentEvent?.objectType, 'agent')

  const serialized = JSON.stringify(events)
  assert.doesNotMatch(serialized, /不得进入运营投影的回答正文/)
  assert.match(serialized, /SYNTHETIC_FAILURE/)
})

test('run drill-down is scoped to one run and exposes traceable safe metadata', async () => {
  const events = await operations.getRunOperations(runId)
  assert.ok(events.length >= 4)
  assert.ok(events.every((event) => event.runId === runId))
  assert.ok(events.some((event) => event.attemptId === attemptId && event.category === 'model'))
  assert.ok(events.some((event) => event.status === 'blocked' && event.category === 'tool'))
  const [toolAudit] = await database<{ toolVersionId: string }[]>`
    select tool_version_id as "toolVersionId" from tool_audit_logs
     where tenant_id = 'tenant-dsh-work' and run_id = ${runId} and attempt_id = ${attemptId}
     order by occurred_at desc limit 1
  `
  assert.equal(toolAudit?.toolVersionId, 'tool-version-read-1')
  await assert.rejects(operations.getRunOperations('run-does-not-exist'), /Run 不存在/)
})

test('24-hour operations summary is calculated from persisted facts', async () => {
  const summary = await operations.getOperationsSummary()
  assert.ok(summary.runs24h >= 1)
  assert.ok(summary.modelTokens24h >= 20)
  assert.ok(summary.toolCalls24h >= 1)
  assert.ok(summary.artifacts24h >= 1)
  assert.ok(summary.attentionEvents24h >= 3)
})
