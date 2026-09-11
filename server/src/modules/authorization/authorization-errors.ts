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
