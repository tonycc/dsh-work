import {
  PLATFORM_SETTING_DEFINITIONS,
  platformSettingDefinition,
  validatePlatformSettingValue,
  type PlatformSettingChange,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import { invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import type { RuntimeParametersPort } from '../../http/admin/runtime-parameters-routes.ts'
import {
  buildRuntimeParametersOverview,
  type RuntimeParameterOwner,
  type RuntimeParametersOverview,
} from '../../modules/platform-settings/runtime-parameters-overview.ts'

/**
 * P0 冒烟的运行参数（RP-E2E-01、RP-E2E-02）：确定性内存数据。Runtime 单次执行超时 3 分钟，
 * 短于 2 个已发布 Agent 的运行超时，用于展示超时链路的截断提示。不代表真实数据库读写。
 */
export class SmokeRuntimeParametersService implements RuntimeParametersPort {
  private readonly saved = new Map<string, { value: number; revision: number; updatedAt: string }>()

  async list(): Promise<PlatformSettingView[]> {
    return PLATFORM_SETTING_DEFINITIONS.map(definition => {
      const row = this.saved.get(definition.key)
      return {
        key: definition.key, group: definition.group, label: definition.label, description: definition.description,
        unit: definition.unit, value: row?.value ?? definition.defaultValue, defaultValue: definition.defaultValue,
        min: definition.min, max: definition.max, timing: definition.timing,
        ...(definition.lowerRisk ? { lowerRisk: definition.lowerRisk } : {}),
        source: row ? 'page' : 'default',
        revision: row?.revision ?? 0,
        ...(row ? { updatedAt: row.updatedAt, updatedBy: '系统管理员' } : {}),
      }
    })
  }

  async save(changes: PlatformSettingChange[]): Promise<PlatformSettingView[]> {
    const validated = changes.map(change => {
      const definition = platformSettingDefinition(change.key)
      if (!definition) throw invalidRequest(`未登记的运行参数：${change.key}`)
      const value = validatePlatformSettingValue(change.key, change.value)
      if ((this.saved.get(change.key)?.revision ?? 0) !== change.revision) {
        throw stateConflict(`“${definition.label}”已被其他管理员修改，请刷新后重试`)
      }
      return { key: change.key, value, defaultValue: definition.defaultValue }
    })
    const updatedAt = new Date().toISOString()
    for (const { key, value, defaultValue } of validated) {
      if (value === defaultValue) this.saved.delete(key)
      else this.saved.set(key, { value, revision: (this.saved.get(key)?.revision ?? 0) + 1, updatedAt })
    }
    return this.list()
  }

  async overview(input: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview> {
    return buildRuntimeParametersOverview({
      settings: await this.list(),
      runtimes: [{ id: 'runtime-local-01', name: 'runtime-local-01', capacity: 4, timeoutSeconds: 180, agentsOverTimeout: 2 }],
      sessionTtl: input.sessionTtl,
      dingtalk: { source: 'admin', sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10_000 },
      canEdit: input.canEdit,
    })
  }
}
