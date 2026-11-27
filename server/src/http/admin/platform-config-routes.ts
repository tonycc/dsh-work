import { canEditAdminSetting } from '../../domain/admin-permissions.ts'
import {
  PLATFORM_SETTING_GROUPS,
  parsePlatformSettingChanges,
  settingSavePermission,
  type PlatformSettingChange,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import type { RuntimeParameterOwner, RuntimeParametersOverview } from '../../modules/platform-settings/runtime-parameters-overview.ts'
import { accessDenied } from '../../domain/request-errors.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

export interface PlatformConfigPort {
  list(): Promise<PlatformSettingView[]>
  save(changes: PlatformSettingChange[], actorId: string): Promise<PlatformSettingView[]>
  overview(input: {
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview>
  /** 接受调度的 Runtime 的单次执行超时，供 Agent 能力页提示实际生效超时。 */
  runtimeLimits(): Promise<RuntimeLimit[]>
}

export interface RuntimeLimit { id: string; name: string; timeoutSeconds: number }

/**
 * 管理端“平台配置”（运行参数配置方案 6.6）：查看与保存按“平台配置”模块（路由对照表 `platform-config`、`platform-settings`）；
 * 安全类参数由服务层逐项复核平台管理员（RP16）。每项返回当前管理员能否修改（只用于展示）。
 */
export function registerPlatformConfigRoutes(
  router: Router,
  parameters: PlatformConfigPort,
  options: {
    /** 数据卷当前剩余空间，供页面在调高磁盘阈值前提示“保存后将立即判定为磁盘不足”；读取失败时为 null。 */
    diskStatus?: () => Promise<{ freeBytes: number; totalBytes: number } | null>
    adapter?: 'postgres' | 'prototype-memory'
  },
) {
  const adapter = options.adapter ?? 'postgres'
  router.get('/api/admin/v1/platform-config', async (_request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const canEdit = (owner: NonNullable<RuntimeParameterOwner>) => canEditAdminSetting(identity.permissions, owner)
    const [settings, overview, disk] = await Promise.all([
      parameters.list(),
      parameters.overview({ canEdit }),
      options.diskStatus ? options.diskStatus().catch(() => null) : Promise.resolve(null),
    ])
    const withPermission = settings.map(setting => ({
      ...setting,
      canEdit: setting.available && canEdit(setting.savePermission === 'platform-admin' ? { kind: 'platform-admin' } : { kind: 'module', module: 'config' }),
    }))
    return envelope('admin', {
      groups: PLATFORM_SETTING_GROUPS, settings: withPermission, canSave: withPermission.some(setting => setting.canEdit), disk, overview,
    }, adapter)
  })
  // Agent 能力页的只读选择器（路由对照表 SELECTOR_PATHS）：只返回 Runtime 的 ID、名称与单次执行超时。
  router.get('/api/admin/v1/platform-config/runtime-limits', async (_request, context) => {
    requireRequestIdentity(context, 'admin')
    const limits = await parameters.runtimeLimits()
    return envelope('admin', limits.map(({ id, name, timeoutSeconds }) => ({ id, name, timeoutSeconds })), adapter)
  })
  router.put('/api/admin/v1/platform-settings', async (request, context) => {
    const identity = requireRequestIdentity(context, 'admin')
    const changes = parsePlatformSettingChanges(await readJsonBody(request))
    // 逐项保存权限（RP16）：路由层先按判定模块拒绝安全类参数，服务层在事务内再复核一次。
    for (const change of changes) {
      const permission = settingSavePermission(change.key)
      if (permission && !canEditAdminSetting(identity.permissions, permission === 'platform-admin' ? { kind: 'platform-admin' } : { kind: 'module', module: 'config' })) {
        throw accessDenied(permission === 'platform-admin' ? '登录会话与钉钉的安全类参数只有平台管理员可以修改' : '当前用户没有平台配置的修改权限')
      }
    }
    return envelope('admin', { settings: await parameters.save(changes, identity.userId) }, adapter)
  })
}
