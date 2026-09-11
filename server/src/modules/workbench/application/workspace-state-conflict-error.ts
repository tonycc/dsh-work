/**
 * Typed state-conflict error (batch 3 / 3-T2).
 *
 * "Refuse to archive while the workspace still has queued/running/cancelled-
 * requested runs" is a state conflict, not an authorization decision and not an
 * input validation error. Carrying an explicit `status`/`code` keeps the HTTP
 * mapping (409 state_conflict) out of the Chinese message regex, the same way
 * `AuthorizationDeniedError` keeps authorization denials out of it.
 */
export class WorkspaceStateConflictError extends Error {
  readonly status = 409
  readonly code = 'state_conflict'

  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceStateConflictError'
  }
}

export function workspaceStateConflict(message: string): WorkspaceStateConflictError {
  return new WorkspaceStateConflictError(message)
}
