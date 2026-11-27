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
  options: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    /** 数据卷当前剩余空间，供页面在调高磁盘阈值前提示“保存后将立即判定为磁盘不足”；读取失败时为 null。 */
    diskStatus?: () => Promise<{ freeBytes: number; totalBytes: number } | null>
    adapter?: 'postgres' | 'prototype-memory'
  },
) {
  const adapter = options.adapter ?? 'postgres'
  router.get('/api/admin/v1/runtime-parameters', async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const canEdit = (owner: NonNullable<RuntimeParameterOwner>) => canEditAdminSetting(identity.permissions, owner)
    const [settings, overview, disk] = await Promise.all([
      parameters.list(),
      parameters.overview({ sessionTtl: options.sessionTtl, canEdit }),
      options.diskStatus ? options.diskStatus().catch(() => null) : Promise.resolve(null),
    ])
    return envelope('admin', { groups: PLATFORM_SETTING_GROUPS, settings, canSave: canEdit({ kind: 'platform-admin' }), disk, overview }, adapter)
  })
  router.put('/api/admin/v1/platform-settings', async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const changes = parsePlatformSettingChanges(await readJsonBody(request))
    return envelope('admin', { settings: await parameters.save(changes, identity.userId) }, adapter)
  })
}
