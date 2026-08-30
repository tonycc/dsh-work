import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { RunRepository } from './run-repository.ts'
import { assertAttemptTransition, assertRunTransition, isTerminalState } from './run-state-machine.ts'
import type {
  AttemptState,
  CreateAttemptInput,
  CreateRunInput,
  JsonObject,
  RunAttemptRecord,
  RunRecord,
  RunState,
  StoredRunEvent,
} from './run-types.ts'

interface RunRow {
  id: string
  tenantId: string
  sessionId: string
  requestedBy: string
  idempotencyKey: string
  status: RunState
  currentAttemptId: string | null
  createdAt: Date
  updatedAt: Date
}

interface AttemptRow {
  id: string
  tenantId: string
  runId: string
  attemptNo: number
  runtimeId: string | null
  manifest: JsonObject
  manifestSha256: string
  modelRouteSnapshot: JsonObject
  status: AttemptState
  startedAt: Date | null
  endedAt: Date | null
  errorCode: string | null
  createdAt: Date
}

interface EventRow {
  id: string
  tenantId: string
  runId: string
  attemptId: string
  sequence: string | number
  eventType: string
  displayMessage: string | null
  safeMetadata: JsonObject
  traceId: string
  occurredAt: Date
  streamPosition: string | number
}

export class PostgresRunRepository implements RunRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const runId = `run-${randomUUID()}`
    const [created] = await this.database<RunRow[]>`
      insert into runs (
        id, tenant_id, session_id, requested_by, idempotency_key, status
      ) values (
        ${runId}, ${input.tenantId}, ${input.sessionId}, ${input.requestedBy}, ${input.idempotencyKey}, 'queued'
      )
      on conflict (tenant_id, session_id, requested_by, idempotency_key) do nothing
      returning id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
                idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
                created_at as "createdAt", updated_at as "updatedAt"
    `
    if (created) return mapRun(created)
    const [existing] = await this.database<RunRow[]>`
      select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
             idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
             created_at as "createdAt", updated_at as "updatedAt"
        from runs
       where tenant_id = ${input.tenantId} and session_id = ${input.sessionId}
         and requested_by = ${input.requestedBy} and idempotency_key = ${input.idempotencyKey}
    `
    if (!existing) throw new Error('幂等 Run 查询失败')
    return mapRun(existing)
  }

  async getRun(tenantId: string, runId: string) {
    const [row] = await this.database<RunRow[]>`
      select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
             idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
             created_at as "createdAt", updated_at as "updatedAt"
        from runs where tenant_id = ${tenantId} and id = ${runId}
    `
    return row ? mapRun(row) : null
  }

  async getAttempt(tenantId: string, attemptId: string) {
    const [row] = await this.database<AttemptRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
             runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
             model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
             ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
        from run_attempts where tenant_id = ${tenantId} and id = ${attemptId}
    `
    return row ? mapAttempt(row) : null
  }

  async createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord> {
    return this.database.begin(async (transaction) => {
      const [run] = await transaction<{ status: RunState }[]>`
        select status from runs where tenant_id = ${input.tenantId} and id = ${input.runId} for update
      `
      if (!run) throw new Error(`Run 不存在：${input.runId}`)
      if (!['queued', 'failed', 'cancelled'].includes(run.status)) {
        throw new Error(`Run 当前状态不能创建 Attempt：${run.status}`)
      }
      const [counter] = await transaction<{ next: number }[]>`
        select coalesce(max(attempt_no), 0)::integer + 1 as next
          from run_attempts where tenant_id = ${input.tenantId} and run_id = ${input.runId}
      `
      const attemptId = input.attemptId ?? `attempt-${randomUUID()}`
      const [created] = await transaction<AttemptRow[]>`
        insert into run_attempts (
          id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256,
          model_route_snapshot, status
        ) values (
          ${attemptId}, ${input.tenantId}, ${input.runId}, ${counter?.next ?? 1}, ${input.runtimeId ?? null},
          ${transaction.json(input.manifest)}, ${input.manifestSha256},
          ${transaction.json(input.modelRouteSnapshot)}, 'queued'
        )
        returning id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
                  runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
                  model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
                  ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
      `
      await transaction`
        update runs
           set current_attempt_id = ${attemptId}, status = 'queued', updated_at = now()
         where tenant_id = ${input.tenantId} and id = ${input.runId}
      `
      if (!created) throw new Error('Attempt 创建失败')
      return mapAttempt(created)
    })
  }

  async transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord> {
    return this.database.begin(async (transaction) => {
      const [current] = await transaction<RunRow[]>`
        select id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
               idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
               created_at as "createdAt", updated_at as "updatedAt"
          from runs where tenant_id = ${tenantId} and id = ${runId} for update
      `
      if (!current) throw new Error(`Run 不存在：${runId}`)
      assertRunTransition(current.status, to)
      if (current.status === to) return mapRun(current)
      const [updated] = await transaction<RunRow[]>`
        update runs set status = ${to}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${runId}
         returning id, tenant_id as "tenantId", session_id as "sessionId", requested_by as "requestedBy",
                   idempotency_key as "idempotencyKey", status, current_attempt_id as "currentAttemptId",
                   created_at as "createdAt", updated_at as "updatedAt"
      `
      if (!updated) throw new Error(`Run 状态更新失败：${runId}`)
      return mapRun(updated)
    })
  }

  async claimAttempt(tenantId: string, attemptId: string, runtimeId: string): Promise<boolean> {
    return this.database.begin(async (transaction) => {
      const [runtime] = await transaction<{ capacity: number; schedulingStatus: string }[]>`
        select capacity, scheduling_status as "schedulingStatus"
          from runtimes where tenant_id = ${tenantId} and id = ${runtimeId} for update
      `
      if (!runtime || runtime.schedulingStatus !== 'accepting') return false
      const [usage] = await transaction<{ active: number }[]>`
        select count(*)::integer as active from run_attempts
         where tenant_id = ${tenantId} and runtime_id = ${runtimeId} and status = 'running'
      `
      if ((usage?.active ?? 0) >= runtime.capacity) return false
      const [attempt] = await transaction<{ runId: string }[]>`
        update run_attempts set status = 'running', started_at = coalesce(started_at, now())
         where tenant_id = ${tenantId} and id = ${attemptId} and status = 'queued'
         returning run_id as "runId"
      `
      if (!attempt) return false
      await transaction`
        update runs set status = 'running', updated_at = now()
         where tenant_id = ${tenantId} and id = ${attempt.runId} and status = 'queued'
      `
      return true
    })
  }

  async transitionAttempt(
    tenantId: string,
    attemptId: string,
    to: AttemptState,
    errorCode?: string,
  ): Promise<RunAttemptRecord> {
    return this.database.begin(async (transaction) => {
      const [current] = await transaction<AttemptRow[]>`
        select id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
               runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
               model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
               ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
          from run_attempts where tenant_id = ${tenantId} and id = ${attemptId} for update
      `
      if (!current) throw new Error(`Attempt 不存在：${attemptId}`)
      assertAttemptTransition(current.status, to)
      if (current.status === to) return mapAttempt(current)
      const startedAt = to === 'running' && !current.startedAt ? new Date() : current.startedAt
      const endedAt = isTerminalState(to) ? new Date() : null
      const [updated] = await transaction<AttemptRow[]>`
        update run_attempts
           set status = ${to}, started_at = ${startedAt}, ended_at = ${endedAt},
               error_code = ${errorCode ?? null}
         where tenant_id = ${tenantId} and id = ${attemptId}
         returning id, tenant_id as "tenantId", run_id as "runId", attempt_no as "attemptNo",
                   runtime_id as "runtimeId", manifest, manifest_sha256 as "manifestSha256",
                   model_route_snapshot as "modelRouteSnapshot", status, started_at as "startedAt",
                   ended_at as "endedAt", error_code as "errorCode", created_at as "createdAt"
      `
      if (!updated) throw new Error(`Attempt 状态更新失败：${attemptId}`)
      return mapAttempt(updated)
    })
  }

  async appendEvent(event: StoredRunEvent): Promise<StoredRunEvent> {
    const [created] = await this.database<EventRow[]>`
      insert into run_events (
        id, tenant_id, run_id, attempt_id, sequence, event_type, display_message,
        safe_metadata, trace_id, occurred_at
      ) values (
        ${event.id}, ${event.tenantId}, ${event.runId}, ${event.attemptId}, ${event.sequence},
        ${event.eventType}, ${event.displayMessage}, ${this.database.json(event.safeMetadata)},
        ${event.traceId}, ${event.occurredAt}
      )
      on conflict (id) do nothing
      returning id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
                sequence, event_type as "eventType", display_message as "displayMessage",
                safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
                stream_position as "streamPosition"
    `
    if (created) return mapEvent(created)
    const [existing] = await this.database<EventRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events where tenant_id = ${event.tenantId} and id = ${event.id}
    `
    if (!existing) throw new Error(`Run Event 幂等查询失败：${event.id}`)
    if (existing.runId !== event.runId || existing.attemptId !== event.attemptId || Number(existing.sequence) !== event.sequence) {
      throw new Error(`Run Event 幂等键冲突：${event.id}`)
    }
    return mapEvent(existing)
  }

  async readEvents(tenantId: string, runId: string, afterSequence = 0) {
    const rows = await this.database<EventRow[]>`
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events
       where tenant_id = ${tenantId} and run_id = ${runId} and sequence > ${afterSequence}
       order by sequence asc
    `
    return rows.map(mapEvent)
  }

  async readEventsAfterEvent(tenantId: string, runId: string, afterEventId?: string) {
    const rows = await this.database<EventRow[]>`
      with cursor as (
        select stream_position
          from run_events
         where tenant_id = ${tenantId} and run_id = ${runId} and id = ${afterEventId ?? ''}
      )
      select id, tenant_id as "tenantId", run_id as "runId", attempt_id as "attemptId",
             sequence, event_type as "eventType", display_message as "displayMessage",
             safe_metadata as "safeMetadata", trace_id as "traceId", occurred_at as "occurredAt",
             stream_position as "streamPosition"
        from run_events
       where tenant_id = ${tenantId} and run_id = ${runId}
         and stream_position > coalesce((select stream_position from cursor), 0)
       order by stream_position asc
    `
    return rows.map(mapEvent)
  }
}

function mapRun(row: RunRow): RunRecord {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

function mapAttempt(row: AttemptRow): RunAttemptRecord {
  return {
    ...row,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapEvent(row: EventRow): StoredRunEvent {
  return {
    ...row,
    sequence: Number(row.sequence),
    streamPosition: Number(row.streamPosition),
    occurredAt: row.occurredAt.toISOString(),
  }
}
