import type {
  AttemptState,
  CreateAttemptInput,
  CreateRunInput,
  RunAttemptRecord,
  RunRecord,
  RunState,
  StoredRunEvent,
} from './run-types.ts'

export interface RestartRecoveryResult {
  failed: Array<{ runId: string; attemptId: string }>
  queued: Array<{ run: RunRecord; attempt: RunAttemptRecord }>
}

export interface RunRepository {
  createRun(input: CreateRunInput): Promise<RunRecord>
  getRun(tenantId: string, runId: string): Promise<RunRecord | null>
  getAttempt(tenantId: string, attemptId: string): Promise<RunAttemptRecord | null>
  createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord>
  claimAttempt(tenantId: string, attemptId: string, runtimeId: string): Promise<boolean>
  transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord>
  transitionAttempt(
    tenantId: string,
    attemptId: string,
    to: AttemptState,
    errorCode?: string,
  ): Promise<RunAttemptRecord>
  appendEvent(event: StoredRunEvent): Promise<StoredRunEvent>
  readEvents(tenantId: string, runId: string, afterSequence?: number): Promise<StoredRunEvent[]>
  readEventsAfterEvent(tenantId: string, runId: string, afterEventId?: string): Promise<StoredRunEvent[]>
  recoverAfterRestart(tenantId: string, runtimeId: string): Promise<RestartRecoveryResult>
}
