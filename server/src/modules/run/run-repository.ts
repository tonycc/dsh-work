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

export interface RestartRecoveryResult {
  failed: Array<{ runId: string; attemptId: string }>
  queued: Array<{ run: RunRecord; attempt: RunAttemptRecord }>
}

/** An active run in a team workspace with its session's pinned agent version (1A-T5 sweep). */
export type WorkspaceActiveRun = RunRecord & { agentVersionId: string }

export interface AppendSystemEventInput {
  tenantId: string
  runId: string
  attemptId: string
  eventType: string
  displayMessage: string | null
  safeMetadata?: JsonObject
  traceId: string
  occurredAt?: string
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
  /** Appends a server-authored event, computing the next per-attempt sequence transactionally. */
  appendSystemEvent(input: AppendSystemEventInput): Promise<StoredRunEvent>
  readEvents(tenantId: string, runId: string, afterSequence?: number): Promise<StoredRunEvent[]>
  readEventsAfterEvent(tenantId: string, runId: string, afterEventId?: string): Promise<StoredRunEvent[]>
  recoverAfterRestart(tenantId: string, runtimeId: string): Promise<RestartRecoveryResult>
  /**
   * Active (queued/running/cancel_requested) runs of one user in one
   * workspace, joined through sessions (1A-T5 revocation sweep).
   */
  listActiveRunsForWorkspaceUser(tenantId: string, workspaceId: string, userId: string): Promise<RunRecord[]>
  /**
   * Active runs whose session is pinned to the agent version of the given
   * workspace agent member (1A-T5 agent revocation sweep).
   */
  listActiveRunsForAgentMember(tenantId: string, workspaceId: string, agentMemberId: string): Promise<RunRecord[]>
  /** All active runs in a workspace with the session's pinned agent version. */
  listActiveRunsInWorkspace(tenantId: string, workspaceId: string): Promise<WorkspaceActiveRun[]>
}
