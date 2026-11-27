import {
  DINGTALK_PARAMETER_DEFINITIONS,
  PLATFORM_SETTING_DEFINITIONS,
  parseRuntimeSettingKey,
  platformSettingDefinition,
  platformSettingView,
  runtimeSettingDefinitions,
  settingView,
  validateSettingValue,
  type PlatformSettingChange,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import { invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import type { PlatformConfigPort } from '../../http/admin/platform-config-routes.ts'
import {
  buildRuntimeParametersOverview,
  type RuntimeParameterOwner,
  type RuntimeParametersOverview,
  type RuntimeSummary,
} from '../../modules/platform-settings/runtime-parameters-overview.ts'
import type { SmokeRepository } from './smoke-repository.ts'

/** 冒烟数据中已发布 Agent 的运行超时（秒），用于超时链路的截断统计。 */
const PUBLISHED_AGENT_TIMEOUTS = [300, 600]

/**
 * P0 冒烟的平台配置（RP-E2E-01、02、04）：确定性内存数据，与数据库实现同一语义（恢复默认值为 null、版本递增、
 * 值不变不写、按存储行比对版本）。Runtime 容量与超时读写冒烟仓库中的 Runtime，Runtimes 页看到同一份数据。
 * 不判定权限：保存权限由路由对照表判定，冒烟只按身份展示。
 */
export class SmokePlatformConfigService implements PlatformConfigPort {
  private readonly saved = new Map<string, { value: number | null; revision: number; updatedAt: string }>()
  private readonly runtimeRevisions = new Map<string, number>()
  private dingtalk = { sessionTtlSeconds: 43_200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10_000, revision: 1 }
  private readonly repository: SmokeRepository

  constructor(repository: SmokeRepository) {
    this.repository = repository
  }

  async list(): Promise<PlatformSettingView[]> {
    const platform = PLATFORM_SETTING_DEFINITIONS.map(definition => {
      const row = this.saved.get(definition.key)
      return platformSettingView(definition, row && { ...row, updatedBy: '系统管理员' })
    })
    const runtimes = (await this.repository.read('runtimes')).flatMap(runtime => {
      const revision = this.runtimeRevisions.get(runtime.id) ?? 0
      return runtimeSettingDefinitions({ id: runtime.id, name: runtime.name }).map(definition => settingView(definition, {
        value: definition.key.endsWith('.capacity') ? runtime.maxConcurrentWorkers : runtime.attemptTimeoutMinutes,
        source: revision > 0 ? 'page' : 'default', revision, versionKey: `runtime:${runtime.id}`,
      }))
    })
    const dingtalk = DINGTALK_PARAMETER_DEFINITIONS.map(definition => settingView(definition, {
      value: Math.ceil(this.dingtalk[({ session_ttl_seconds: 'sessionTtlSeconds', binding_ticket_ttl_seconds: 'bindingTicketTtlSeconds', admin_daily_bind_limit: 'adminDailyBindLimit', timeout_ms: 'timeoutMs' } as const)[definition.column]] / (definition.scale ?? 1)),
      source: this.dingtalk.revision > 1 ? 'page' : 'default', revision: this.dingtalk.revision, versionKey: 'dingtalk',
    }))
    return [...platform, ...runtimes, ...dingtalk]
  }

  async save(changes: PlatformSettingChange[]): Promise<PlatformSettingView[]> {
    const current = new Map((await this.list()).map(view => [view.key, view]))
    const resolved = changes.map(change => {
      const runtimeKey = parseRuntimeSettingKey(change.key)
      const definition = runtimeKey
        ? runtimeSettingDefinitions({ id: runtimeKey.runtimeId, name: runtimeKey.runtimeId }).find(item => item.key === change.key)
        : platformSettingDefinition(change.key)
      const view = current.get(change.key)
      if (!definition || !view) throw invalidRequest(`未登记的运行参数：${change.key}`)
      if (view.revision !== change.revision) throw stateConflict(`“${definition.label}”已被其他管理员修改，请刷新后重试`)
      return { definition, view, runtimeKey, value: validateSettingValue(definition, change.value) }
    })
    // 与数据库实现一致：同组版本号须一致；全部校验通过后才写入（数据库实现在同一事务内）。
    const groupRevision = new Map<string, number>()
    for (const { view } of resolved) {
      const known = groupRevision.get(view.versionKey)
      if (known !== undefined && known !== view.revision) throw invalidRequest('同一组参数的版本号不一致，请刷新后重试')
      groupRevision.set(view.versionKey, view.revision)
    }
    const runtimes = await this.repository.read('runtimes')
    for (const { runtimeKey, value, view } of resolved) {
      if (runtimeKey?.field !== 'capacity' || value === view.value) continue
      const runtime = runtimes.find(item => item.id === runtimeKey.runtimeId)!
      if (value < runtime.activeWorkers) throw stateConflict(`Runtime 容量不能小于当前活动 Worker 数 ${runtime.activeWorkers}`)
    }
    const updatedAt = new Date().toISOString()
    const touchedRuntimes = new Set<string>()
    let dingtalkTouched = false
    for (const { definition, view, runtimeKey, value } of resolved) {
      if (value === view.value) continue
      if (definition.storage === 'platform') {
        const row = this.saved.get(definition.key)
        this.saved.set(definition.key, { value: value === definition.defaultValue ? null : value, revision: (row?.revision ?? 0) + 1, updatedAt })
      } else if (runtimeKey) {
        await this.repository.updateRuntime(runtimeKey.runtimeId, runtimeKey.field === 'capacity' ? { maxConcurrentWorkers: value } : { attemptTimeoutMinutes: value })
        touchedRuntimes.add(runtimeKey.runtimeId)
      } else {
        const column = DINGTALK_PARAMETER_DEFINITIONS.find(item => item.key === definition.key)!.column
        const field = ({ session_ttl_seconds: 'sessionTtlSeconds', binding_ticket_ttl_seconds: 'bindingTicketTtlSeconds', admin_daily_bind_limit: 'adminDailyBindLimit', timeout_ms: 'timeoutMs' } as const)[column]
        this.dingtalk = { ...this.dingtalk, [field]: value * (definition.scale ?? 1) }
        dingtalkTouched = true
      }
    }
    for (const id of touchedRuntimes) this.runtimeRevisions.set(id, (this.runtimeRevisions.get(id) ?? 0) + 1)
    if (dingtalkTouched) this.dingtalk = { ...this.dingtalk, revision: this.dingtalk.revision + 1 }
    return this.list()
  }

  /** P0 冒烟的固定磁盘状态：500 GB 中剩余 120 GB。 */
  async diskStatus() {
    return { freeBytes: 120 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }
  }

  async overview(input: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview> {
    const runtimes: RuntimeSummary[] = (await this.repository.read('runtimes'))
      .filter(runtime => runtime.schedulingStatus === 'accepting')
      .map(runtime => ({
        id: runtime.id, name: runtime.name, capacity: runtime.maxConcurrentWorkers, timeoutSeconds: runtime.attemptTimeoutMinutes * 60,
        configured: (this.runtimeRevisions.get(runtime.id) ?? 0) > 0,
        agentsOverTimeout: PUBLISHED_AGENT_TIMEOUTS.filter(seconds => seconds > runtime.attemptTimeoutMinutes * 60).length,
      }))
    return buildRuntimeParametersOverview({ settings: await this.list(), runtimes, sessionTtl: input.sessionTtl, canEdit: input.canEdit })
  }
}
