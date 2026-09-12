import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import type { PostgresWorkspaceUsageService } from '../../modules/workbench/application/postgres-workspace-usage-service.ts'
import {
  envelope,
  requireRequestIdentity,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * 空间用量只读接口（批次 4 / 4-T1 / TW-09，AC-30）。
 *
 * 路由守卫是 READ 轨（`allowArchived: true`）：归档空间的现任成员仍可作为第一道
 * 未缓存门禁通过，真正的角色门禁（仅 owner/admin）与每次都重新解析的成员资格由
 * 服务层完成。个人空间不在这里拦截，交由服务层按团队专用惯例返回 422（AC-23）。
 */
export function registerWorkspaceUsageRoutes(
  router: Router,
  usage: PostgresWorkspaceUsageService,
  authorization: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces/:workspaceId/usage`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const workspaceId = context.params['workspaceId'] ?? ''
    // 空白 id 不参与路由守卫的空间解析（否则会先落 403），只在这里完成员工有效身份
    // 校验，再由服务层按「空 id → 422」的顺序拒绝，避免回退到调用者的个人空间。
    await authorization.authorizeWorkbench({
      userId: identity.userId,
      workspaceId: workspaceId.trim() || undefined,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    return envelope(
      'workbench',
      await usage.getWorkspaceUsage({
        workspaceId,
        actorUserId: identity.userId,
        range: context.url.searchParams.get('range') ?? undefined,
      }),
      'postgres',
    )
  })
}
