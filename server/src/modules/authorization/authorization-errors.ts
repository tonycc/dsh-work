/**
 * Typed authorization denial (1A-T5).
 *
 * The revocation sweep must cancel in-flight runs ONLY for a real authorization
 * denial, never for an infrastructure failure, and the HTTP layer must answer
 * 403. Both used to depend on matching the Chinese message text, so any new
 * denial message silently stopped cancelling runs (or answered 500).
 *
 * Carrying an explicit `status`/`code` fixes both: the router's typed-error
 * branch maps it to 403 and `isAuthorizationDenial` recognizes it by identity.
 * Prefer this over a bare `Error` for every authorization decision that can
 * deny a request or revoke a run.
 */
export class AuthorizationDeniedError extends Error {
  readonly status = 403
  readonly code = 'permission_denied'

  constructor(message: string) {
    super(message)
    this.name = 'AuthorizationDeniedError'
  }
}

export function authorizationDenied(message: string): AuthorizationDeniedError {
  return new AuthorizationDeniedError(message)
}

/**
 * True only for an explicit authorization denial. The message list is a
 * fallback for the plain-Error denials that predate the typed error; new code
 * should throw `authorizationDenied(...)`.
 */
const LEGACY_DENIAL_MESSAGES = [
  '当前用户没有员工工作台使用权限',
  '当前用户不存在、已停用或所属企业不可用',
  '当前用户角色不可使用所选 Agent',
  '当前用户角色不可调用工具',
  '当前用户已不是该团队空间成员',
  '当前用户角色为只读',
  '工作空间不存在、已归档或当前用户不是成员',
  '工作空间不存在或已归档',
  '工作空间未配置',
  '工作空间未授权',
  'Agent Version 不存在、未发布或所属 Agent 已停用',
  'Skill 不存在、未发布或已停用',
  '工具不存在、未发布、不可用或不符合一期只读策略',
  'Agent 必须显式授权所选 Skill 依赖的工具',
  '要求未授权的数据范围',
]

export function isAuthorizationDenial(error: unknown): boolean {
  if (error instanceof AuthorizationDeniedError) return true
  const message = error instanceof Error ? error.message : ''
  return LEGACY_DENIAL_MESSAGES.some(fragment => message.includes(fragment))
}

/**
 * Read-access check for a team-workspace object, shared by every 1A/1B read
 * surface (runs, tasks, files, artifacts). Kept in one place because the
 * existence branch is a security decision, not a detail: a missing workspace
 * must fail CLOSED. Duplicating this branch is how file/artifact reads and run
 * reads drift apart.
 *
 * 3-T1 dual track (归档 = 只读保留): the READ track resolves the workspace type
 * with `readableWorkspaceTypeOf` so an ARCHIVED team workspace is still
 * visible, then requires CURRENT membership through `authorizeTeamReadAccess`
 * (which is called here with an explicit `allowArchived: true`; the method's
 * OWN default stays active-only, so a caller that forgets to decide fails closed).
 * A removed member, a nonexistent
 * workspace or an unknown status still denies. Execution stays untouched:
 * `workspaceTypeOf`, `requireTeamRole` and `requireWorkspaceMembership` keep
 * their active-only default and are the only resolvers that write/run paths
 * may use.
 *
 * Personal workspaces keep the caller's existing path (AC-23). Only an
 * explicit authorization denial is translated to `false`; infrastructure
 * failures propagate so they cannot masquerade as a permission decision.
 */
export interface TeamReadAccessChecker {
  /** Status-agnostic: resolves 'team' for an archived workspace as well. */
  readableWorkspaceTypeOf(workspaceId: string | null | undefined): Promise<'personal' | 'team' | null>
  /** Read gate: the caller opts in explicitly, so archived is accepted. */
  authorizeTeamReadAccess(
    workspaceId: string,
    userId: string,
    options: { allowArchived: boolean; ttlMs?: number },
  ): Promise<void>
}

export async function canReadWorkspaceObject(
  authorization: TeamReadAccessChecker,
  workspaceId: string | null | undefined,
  userId: string,
  /**
   * 授权缓存 TTL 覆盖。SSE 逐批门禁需要它来控制「多久重新完整复核一次」；
   * 不传时用授权服务的默认值（≤10s）。漏传会让调用点传入的 TTL 被静默忽略。
   */
  options: { ttlMs?: number } = {},
): Promise<boolean> {
  if (!workspaceId) return true
  const workspaceType = await authorization.readableWorkspaceTypeOf(workspaceId)
  if (workspaceType === 'personal') return true
  if (workspaceType === null) return false
  try {
    await authorization.authorizeTeamReadAccess(workspaceId, userId, { allowArchived: true, ttlMs: options.ttlMs })
    return true
  } catch (error) {
    if (isAuthorizationDenial(error)) return false
    throw error
  }
}

/**
 * Typed request-validation rejection (HTTP 422). `classifyHttpError` recognises some
 * wording by regex, so a validation message whose text changes silently becomes a 500;
 * carrying the status explicitly removes that failure mode, mirroring
 * `authorizationDenied` for 403. Services outside the HTTP layer use this instead of
 * importing `routeValidationFailed` from the router (that would invert the layering).
 */
export class RequestValidationError extends Error {
  readonly status = 422
  readonly code = 'invalid_request'

  constructor(message: string) {
    super(message)
    this.name = 'RequestValidationError'
  }
}

export function requestInvalid(message: string): RequestValidationError {
  return new RequestValidationError(message)
}
