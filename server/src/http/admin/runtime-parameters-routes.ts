import { canEditAdminSetting } from '../../domain/admin-permissions.ts'
import {
  PLATFORM_SETTING_GROUPS,
  parsePlatformSettingChanges,
  type PlatformSettingChange,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import type { RuntimeParameterOwner, RuntimeParametersOverview } from '../../modules/platform-settings/runtime-parameters-overview.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

export interface RuntimeParametersPort {
  list(): Promise<PlatformSettingView[]>
  save(changes: PlatformSettingChange[], actorId: string): Promise<PlatformSettingView[]>
  overview(input: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview>
}

/**
 * 管理端“运行参数”（运行参数配置方案 6.3）：总览按 `ops` 查看；保存只限平台管理员（路由对照表 `platform-settings`，RP10）。
 */
export function registerRuntimeParametersRoutes(
  router: Router,
  parameters: RuntimeParametersPort,
  options: { sessionTtl: { seconds: number; fromEnvironment: boolean }; adapter?: 'postgres' | 'prototype-memory' },
) {
  const adapter = options.adapter ?? 'postgres'
  router.get('/api/admin/v1/runtime-parameters', async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const canEdit = (owner: NonNullable<RuntimeParameterOwner>) => canEditAdminSetting(identity.permissions, owner)
    const [settings, overview] = await Promise.all([
      parameters.list(),
      parameters.overview({ sessionTtl: options.sessionTtl, canEdit }),
    ])
    return envelope('admin', { groups: PLATFORM_SETTING_GROUPS, settings, canSave: canEdit({ kind: 'platform-admin' }), overview }, adapter)
  })
  router.put('/api/admin/v1/platform-settings', async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const changes = parsePlatformSettingChanges(await readJsonBody(request))
    return envelope('admin', { settings: await parameters.save(changes, identity.userId) }, adapter)
  })
}
