import type { PostgresAuthorizationService, TeamMemberRole } from '../../modules/authorization/postgres-authorization-service.ts'
import type { RequestIdentity } from '../../modules/identity/types.ts'
import {
  isMemberRole,
  type MemberRole,
  type PostgresWorkspaceMemberService,
} from '../../modules/workbench/application/postgres-workspace-member-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  routePermissionDenied,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Team-space-only employee member management (1A-T3). Personal workspaces are
 * rejected before any role check so personal-space behavior stays unchanged.
 */
export function registerWorkspaceMemberRoutes(
  router: Router,
  members: PostgresWorkspaceMemberService,
  authorization: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces/:workspaceId/member-candidates`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const limit = parseLimit(context.url.searchParams.get('limit'))
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope('workbench', await members.listMemberCandidates(workspaceId, { query, cursor, limit }), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/members`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const body = await readJsonBody<{ userId?: unknown; role?: unknown }>(request)
    const targetUserId = requireNonEmptyString(body.userId, 'userId')
    const role = parseMemberRole(body.role)
    const result = await members.addMember(workspaceId, targetUserId, role, identity.userId)
    return httpResult(result.created ? 201 : 200, envelope('workbench', result.member, 'postgres'))
  })

  router.patch(`${basePath}/workspaces/:workspaceId/members/:userId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const targetUserId = context.params['userId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const body = await readJsonBody<{ role?: unknown }>(request)
    const role = parseMemberRole(body.role)
    const member = await members.changeMemberRole(workspaceId, targetUserId, role, identity.userId)
    return envelope('workbench', member, 'postgres')
  })

  router.delete(`${basePath}/workspaces/:workspaceId/members/:userId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    const targetUserId = context.params['userId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin'])
    const result = await members.removeMember(workspaceId, targetUserId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/exit`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner', 'admin', 'member', 'viewer'])
    const result = await members.exitWorkspace(workspaceId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/owner-transfer`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    await requireTeamActor(authorization, identity, workspaceId, ['owner'])
    const body = await readJsonBody<{ toUserId?: unknown }>(request)
    const toUserId = requireNonEmptyString(body.toUserId, 'toUserId')
    const result = await members.transferWorkspaceOwner(workspaceId, toUserId, identity.userId)
    return envelope('workbench', result, 'postgres')
  })
}

/**
 * Identity + workspace resolution + team-only boundary + role check, per the
 * 1A-T3 contract. Only requireTeamRole's two known denial messages are
 * re-thrown as typed 403s so the shared error classifier surfaces them as
 * permission_denied; anything else — e.g. a database outage — propagates
 * unchanged and is classified on its own merits.
 */
async function requireTeamActor(
  authorization: PostgresAuthorizationService,
  identity: RequestIdentity,
  workspaceId: string,
  allowedRoles: TeamMemberRole[],
) {
  const access = await authorization.authorizeWorkbench({
    userId: identity.userId,
    workspaceId,
    ...sessionAuthorizationContext(identity),
  })
  if (access.workspaceType !== 'team') throw new Error('仅支持团队工作空间进行成员管理')
  try {
    await authorization.requireTeamRole(workspaceId, identity.userId, allowedRoles)
  } catch (error) {
    if (isTeamRoleDenial(error)) throw routePermissionDenied(error.message)
    throw error
  }
}

/**
 * The two denial messages PostgresAuthorizationService.requireTeamRole
 * raises: missing workspace/membership and role outside the allowed set.
 */
function isTeamRoleDenial(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  return error.message === '工作空间不存在、已归档或当前用户不是成员'
    || error.message.startsWith('当前用户角色无权执行此操作')
}

function parseMemberRole(value: unknown): MemberRole {
  if (!isMemberRole(value)) throw new Error(`无效的角色：${String(value)}`)
  return value
}

function requireNonEmptyString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} 不能为空`)
  return value.trim()
}

function parseLimit(raw: string | null) {
  if (raw === null || raw === '') return 20
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1 到 100 之间的整数')
  return limit
}
