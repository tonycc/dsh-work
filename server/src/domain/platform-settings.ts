import { invalidRequest } from './request-errors.ts'

/**
 * 运行参数登记表（运行参数配置方案 RP2）：页面可修改的平台参数只在这里定义。
 * 服务端校验、总览接口与管理端表单都从这里取，前端不另写常量。
 */
export type PlatformSettingKey =
  | 'disk.min_free_gb'
  | 'disk.min_free_percent'
  | 'workspace.failed_retention_days'
  | 'web_fetch.max_per_attempt'
  | 'automation.max_concurrent'
  | 'notifications.retention_days'
  | 'error_records.retention_days'
  | 'page_views.retention_days'

export type PlatformSettingGroup = 'disk' | 'run' | 'retention'

/** 保存权限（RP10）：运维参数只有平台管理员能保存，查看按 `ops` 模块。 */
export type PlatformSettingSavePermission = 'platform-admin'

export interface PlatformSettingDefinition {
  key: PlatformSettingKey
  module: 'ops'
  savePermission: PlatformSettingSavePermission
  group: PlatformSettingGroup
  label: string
  description: string
  unit: string
  defaultValue: number
  min: number
  max: number
  /** 生效时机，原样展示给管理员。 */
  timing: string
  /** 改小（低于已保存值）时的影响说明；保存确认框据此要求管理员确认。 */
  lowerRisk?: string
}

export const PLATFORM_SETTING_GROUPS: ReadonlyArray<{ id: PlatformSettingGroup; title: string; description: string }> = [
  { id: 'disk', title: '磁盘与工作区', description: '保护数据盘与排查用的工作区。' },
  { id: 'run', title: '并发与运行', description: '影响运行排队与单次运行的行为。' },
  { id: 'retention', title: '数据保留', description: '到期数据在每天的清理任务中删除。' },
]

export const PLATFORM_SETTING_DEFINITIONS: readonly PlatformSettingDefinition[] = [
  {
    key: 'disk.min_free_gb', module: 'ops', savePermission: 'platform-admin', group: 'disk',
    label: '磁盘最低剩余空间', description: '数据盘剩余低于该值（或下方比例）时，执行容器拒绝运行命令，已在运行的命令会被终止。',
    unit: 'GB', defaultValue: 10, min: 2, max: 500, timing: '下一条命令',
    lowerRisk: '调低后，磁盘被写满的风险上升；盘满会影响数据库与所有运行。',
  },
  {
    key: 'disk.min_free_percent', module: 'ops', savePermission: 'platform-admin', group: 'disk',
    label: '磁盘最低剩余比例', description: '与上一项取较大者。',
    unit: '%', defaultValue: 10, min: 0, max: 50, timing: '下一条命令',
    lowerRisk: '调低后，大容量磁盘上的保护会明显变弱。',
  },
  {
    key: 'workspace.failed_retention_days', module: 'ops', savePermission: 'platform-admin', group: 'disk',
    label: '失败工作区保留天数', description: '失败运行的工作区保留用于排查，到期后清理。',
    unit: '天', defaultValue: 3, min: 1, max: 30, timing: '下次清理（每 6 小时）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的失败工作区。',
  },
  {
    key: 'web_fetch.max_per_attempt', module: 'ops', savePermission: 'platform-admin', group: 'run',
    label: '每次运行最多读取网页次数', description: '超过后本次运行的读取网页请求被拒绝，Agent 基于已读内容作答。运行开始时固定，系统提示同步显示该值。',
    unit: '次', defaultValue: 10, min: 1, max: 50, timing: '之后新建的运行',
  },
  {
    key: 'automation.max_concurrent', module: 'ops', savePermission: 'platform-admin', group: 'run',
    label: '自动任务并发', description: '同时执行的定时任务数；实际不超过 Runtime 容量减 1，始终为员工对话保留一路。',
    unit: '个', defaultValue: 2, min: 1, max: 20, timing: '下次调度',
  },
  {
    key: 'notifications.retention_days', module: 'ops', savePermission: 'platform-admin', group: 'retention',
    label: '站内通知保留天数', description: '员工的通知列表与未读数只统计保留期内的通知。',
    unit: '天', defaultValue: 90, min: 30, max: 365, timing: '列表立即生效；删除在下次清理（每天）',
    lowerRisk: '缩短后，早于新天数的通知立即从员工的列表与未读数中消失，下次清理时删除。',
  },
  {
    key: 'error_records.retention_days', module: 'ops', savePermission: 'platform-admin', group: 'retention',
    label: '错误记录保留天数', description: '下限 90 天，保证错误记录页“近 90 天”数据完整。',
    unit: '天', defaultValue: 90, min: 90, max: 365, timing: '下次清理（每天）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的错误记录。',
  },
  {
    key: 'page_views.retention_days', module: 'ops', savePermission: 'platform-admin', group: 'retention',
    label: '页面访问保留天数', description: '下限 90 天，保证使用情况页“近 90 天”数据完整。',
    unit: '天', defaultValue: 180, min: 90, max: 730, timing: '下次清理（每天）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的页面访问记录，使用情况页的历史会变短。',
  },
]

const DEFINITIONS = new Map(PLATFORM_SETTING_DEFINITIONS.map(definition => [definition.key, definition]))

export function platformSettingDefinition(key: string): PlatformSettingDefinition | undefined {
  return DEFINITIONS.get(key as PlatformSettingKey)
}

/** 校验并规范化一个参数值：只接受登记范围内的整数。 */
export function validatePlatformSettingValue(key: string, value: unknown): number {
  const definition = platformSettingDefinition(key)
  if (!definition) throw invalidRequest(`未登记的运行参数：${key}`)
  if (typeof value !== 'number' || !Number.isInteger(value) || value < definition.min || value > definition.max) {
    throw invalidRequest(`“${definition.label}”必须是 ${definition.min}～${definition.max} 之间的整数`)
  }
  return value
}

/** 运维参数的当前值读取口；同步读取进程内快照，保存后立即刷新（单进程部署）。 */
export interface PlatformSettingsReader {
  get(key: PlatformSettingKey): number
}

/** 未接数据库时（单元测试、工具脚本）按登记表默认值。 */
export const defaultPlatformSettings: PlatformSettingsReader = {
  get: key => DEFINITIONS.get(key)!.defaultValue,
}

/** 由数据库行构造读取口：值不合法或键未登记时回落到默认值。 */
export function platformSettingsFromValues(values: ReadonlyMap<string, unknown>): PlatformSettingsReader {
  return {
    get(key) {
      const definition = DEFINITIONS.get(key)!
      const value = values.get(key)
      return typeof value === 'number' && Number.isInteger(value) && value >= definition.min && value <= definition.max
        ? value
        : definition.defaultValue
    },
  }
}

/** 磁盘最低剩余空间与比例（字节、0～1），供执行容器与系统健康共用。 */
export function diskThresholds(settings: PlatformSettingsReader): { minFreeBytes: number; minFreeRatio: number } {
  return {
    minFreeBytes: settings.get('disk.min_free_gb') * 1024 ** 3,
    minFreeRatio: settings.get('disk.min_free_percent') / 100,
  }
}

export interface PlatformSettingView {
  key: PlatformSettingKey
  group: PlatformSettingGroup
  label: string
  description: string
  unit: string
  value: number
  defaultValue: number
  min: number
  max: number
  timing: string
  lowerRisk?: string
  /** `page`：页面保存过；`default`：从未保存，按默认值。 */
  source: 'page' | 'default'
  /** 乐观锁：从未保存时为 0。 */
  revision: number
  updatedAt?: string
  updatedBy?: string
}

export interface PlatformSettingChange {
  key: string
  value: unknown
  revision: unknown
}

export function parsePlatformSettingChanges(body: unknown): PlatformSettingChange[] {
  const changes = (body as { changes?: unknown } | null)?.changes
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > PLATFORM_SETTING_DEFINITIONS.length) {
    throw invalidRequest('请提交要修改的运行参数')
  }
  const seen = new Set<string>()
  return changes.map((change: unknown) => {
    const item = change as { key?: unknown; value?: unknown; revision?: unknown } | null
    if (!item || typeof item.key !== 'string') throw invalidRequest('运行参数缺少键')
    if (seen.has(item.key)) throw invalidRequest(`运行参数重复提交：${item.key}`)
    seen.add(item.key)
    return { key: item.key, value: item.value, revision: item.revision }
  })
}
