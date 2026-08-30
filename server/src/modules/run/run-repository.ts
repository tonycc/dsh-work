import type {
  AttemptState,
  CreateAttemptInput,
  CreateRunInput,
  RunAttemptRecord,
  RunRecord,
  RunState,
  StoredRunEvent,
} from './run-types.ts'

export interface RunRepository {
  createRun(input: CreateRunInput): Promise<RunRecord>
  getRun(tenantId: string, runId: string): Promise<RunRecord | null>
  createAttempt(input: CreateAttemptInput): Promise<RunAttemptRecord>
  transitionRun(tenantId: string, runId: string, to: RunState): Promise<RunRecord>
  transitionAttempt(
    tenantId: string,
    attemptId: string,
    to: AttemptState,
    errorCode?: string,
  ): Promise<RunAttemptRecord>
  appendEvent(event: StoredRunEvent): Promise<StoredRunEvent>
  readEvents(tenantId: string, runId: string, afterSequence?: number): Promise<StoredRunEvent[]>
}
