import { invalidRequest } from './request-errors.ts'

/**
 * 平台配置登记表（运行参数配置方案 RP2、6.6）：页面可修改的平台参数只在这里定义。
 * 服务端校验、总览接口与管理端表单都从这里取，前端不另写常量。
 * 每项登记存储位置（数据不搬家）与保存权限（RP12、RP16）。
 */

/** 存在 `platform_settings` 的键（进程内快照按次读取）。 */
export type PlatformSettingKey =
  | 'disk.min_free_gb'
  | 'disk.min_free_percent'
  | 'workspace.failed_retention_days'
  | 'web_fetch.max_per_attempt'
  | 'automation.max_concurrent'
  | 'notifications.retention_days'
  | 'error_records.retention_days'
  | 'page_views.retention_days'
  | 'session.ttl_hours'
  | 'knowledge.search_timeout_seconds'
  | 'knowledge.upload_timeout_seconds'
  | 'model.headers_timeout_seconds'

/** 存在 `dingtalk_app_configurations` 的四项（RP11）。 */
export type DingTalkParameterKey =
  | 'dingtalk.session_ttl_hours'
  | 'dingtalk.binding_ticket_ttl_minutes'
  | 'dingtalk.admin_daily_bind_limit'
  | 'dingtalk.timeout_seconds'

export type PlatformSettingGroup = 'disk' | 'run' | 'retention' | 'runtime' | 'login' | 'external'

/**
 * 存储位置：`platform` 为 `platform_settings`；`runtime` 为 `runtimes.capacity` 与 `runtime_configurations`；
 * `dingtalk` 为 `dingtalk_app_configurations` 的四列。
 */
export type PlatformSettingStorage = 'platform' | 'runtime' | 'dingtalk'

/** 保存权限（RP12、RP16）：安全类参数只限平台管理员，其余按“平台配置”修改权限。 */
export type PlatformSettingSavePermission = 'platform-admin' | 'config'

export interface PlatformSettingDefinition {
  key: string
  storage: PlatformSettingStorage
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
  /** 改小（低于当前值）时的影响说明；保存确认框据此要求管理员确认。 */
  lowerRisk?: string
  /** 低于默认值时的影响说明（方案第 5 节：磁盘阈值低于默认值时二次确认）。 */
  belowDefaultRisk?: string
  /** 改大（高于当前值）时的影响说明。 */
  raiseRisk?: string
  /** 页面单位与存储单位的换算：存储值 = 页面值 × scale（钉钉、Runtime 超时）。 */
  scale?: number
}

export const PLATFORM_SETTING_GROUPS: ReadonlyArray<{ id: PlatformSettingGroup; title: string; description: string }> = [
  { id: 'disk', title: '磁盘与工作区', description: '保护数据盘与排查用的工作区。' },
  { id: 'run', title: '并发与运行', description: '影响运行排队与单次运行的行为。' },
  { id: 'retention', title: '数据保留', description: '到期数据在每天的清理任务中删除。' },
  { id: 'runtime', title: 'Runtime', description: '每个 Runtime 一行；调度状态与停用工具仍在 Runtimes 页操作。' },
  { id: 'login', title: '登录与钉钉', description: '钉钉 CorpId、AppKey、AppSecret 仍在钉钉集成页配置。' },
  { id: 'external', title: '外部服务', description: '知识库连接地址、密钥与嵌入模型仍在企业知识库页配置。' },
]

export const PLATFORM_SETTING_DEFINITIONS: readonly PlatformSettingDefinition[] = [
  {
    key: 'disk.min_free_gb', storage: 'platform', savePermission: 'config', group: 'disk',
    label: '磁盘最低剩余空间', description: '数据盘剩余低于该值（或下方比例）时，执行容器拒绝运行命令，已在运行的命令会被终止。',
    unit: 'GB', defaultValue: 10, min: 2, max: 500, timing: '立即（包括正在运行的命令）',
    belowDefaultRisk: '低于默认值后，磁盘被写满的风险上升；盘满会影响数据库与所有运行。',
    raiseRisk: '调高后立即生效，包括正在运行的命令：剩余空间低于新阈值时，执行容器拒绝运行命令，正在运行的命令会被终止。',
  },
  {
    key: 'disk.min_free_percent', storage: 'platform', savePermission: 'config', group: 'disk',
    label: '磁盘最低剩余比例', description: '与上一项取较大者。',
    unit: '%', defaultValue: 10, min: 0, max: 50, timing: '立即（包括正在运行的命令）',
    belowDefaultRisk: '低于默认值后，大容量磁盘上的保护会明显变弱。',
    raiseRisk: '调高后立即生效，包括正在运行的命令：剩余空间低于新阈值时，执行容器拒绝运行命令，正在运行的命令会被终止。',
  },
  {
    key: 'workspace.failed_retention_days', storage: 'platform', savePermission: 'config', group: 'disk',
    label: '失败工作区保留天数', description: '失败运行的工作区保留用于排查，到期后清理。',
    unit: '天', defaultValue: 3, min: 1, max: 30, timing: '下次清理（每 6 小时）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的失败工作区。',
  },
  {
    key: 'web_fetch.max_per_attempt', storage: 'platform', savePermission: 'config', group: 'run',
    label: '每次运行最多读取网页次数', description: '超过后本次运行的读取网页请求被拒绝，Agent 基于已读内容作答。运行开始时固定，系统提示同步显示该值。',
    unit: '次', defaultValue: 10, min: 1, max: 50, timing: '之后新建的运行',
  },
  {
    key: 'automation.max_concurrent', storage: 'platform', savePermission: 'config', group: 'run',
    label: '自动任务并发', description: '同时执行的定时任务数；实际不超过 Runtime 容量减 1，始终为员工对话保留一路。',
    unit: '个', defaultValue: 2, min: 1, max: 20, timing: '下次调度',
  },
  {
    key: 'notifications.retention_days', storage: 'platform', savePermission: 'config', group: 'retention',
    label: '站内通知保留天数', description: '员工的通知列表与未读数只统计保留期内的通知。',
    unit: '天', defaultValue: 90, min: 30, max: 365, timing: '列表立即生效；删除在下次清理（每天）',
    lowerRisk: '缩短后，早于新天数的通知立即从员工的列表与未读数中消失，下次清理时删除。',
    raiseRisk: '调大后，尚未清理的更早通知会重新出现在员工的列表与未读数中。',
  },
  {
    key: 'error_records.retention_days', storage: 'platform', savePermission: 'config', group: 'retention',
    label: '错误记录保留天数', description: '下限 90 天，保证错误记录页“近 90 天”数据完整。',
    unit: '天', defaultValue: 90, min: 90, max: 365, timing: '下次清理（每天）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的错误记录。',
  },
  {
    key: 'page_views.retention_days', storage: 'platform', savePermission: 'config', group: 'retention',
    label: '页面访问保留天数', description: '下限 90 天，保证使用情况页“近 90 天”数据完整。',
    unit: '天', defaultValue: 180, min: 90, max: 730, timing: '下次清理（每天）',
    lowerRisk: '缩短后，下次清理将删除早于新天数的页面访问记录，使用情况页的历史会变短。',
  },
  {
    key: 'session.ttl_hours', storage: 'platform', savePermission: 'platform-admin', group: 'login',
    label: '登录会话有效期', description: '员工端与管理端账号密码登录的会话有效期，平台管理员的会话同样受影响。页面从未保存过时沿用环境变量 DSH_WORK_SESSION_TTL_SECONDS。',
    unit: '小时', defaultValue: 8, min: 1, max: 168, timing: '之后签发的会话', scale: 3600,
    lowerRisk: '缩短后只影响之后签发的会话，已登录的会话按原有效期到期。',
  },
  {
    key: 'knowledge.search_timeout_seconds', storage: 'platform', savePermission: 'config', group: 'external',
    label: '知识库检索超时', description: '一次检索串行发两个请求（检索、取文档），各受此超时；Agent 的知识检索工具最多等 25 秒，所以上限 12 秒。',
    unit: '秒', defaultValue: 10, min: 3, max: 12, timing: '下一次检索',
    lowerRisk: '调低后较慢的检索会更早判超时，Agent 得不到知识库结果。',
  },
  {
    key: 'knowledge.upload_timeout_seconds', storage: 'platform', savePermission: 'config', group: 'external',
    label: '知识库上传与下载超时', description: '上传文档、下载原文与预览时等待 WeKnora 的时间。',
    unit: '秒', defaultValue: 120, min: 30, max: 300, timing: '下一次上传、下载或预览',
  },
  {
    key: 'model.headers_timeout_seconds', storage: 'platform', savePermission: 'config', group: 'external',
    label: '模型首个响应超时', description: '全平台一个值：模型在这段时间内没有开始返回即判超时，最多重试 2 次；整次运行仍受运行超时限制。',
    unit: '秒', defaultValue: 120, min: 30, max: 300, timing: '下一次模型请求',
    lowerRisk: '调低后推理较慢的模型更容易判超时并重试，可能导致运行失败。',
  },
]

/** 钉钉四项（RP11）：会话有效期、待绑定凭证有效期与每日代绑上限是安全类，只限平台管理员（RP16）。 */
export const DINGTALK_PARAMETER_DEFINITIONS: readonly (PlatformSettingDefinition & { key: DingTalkParameterKey; column: 'session_ttl_seconds' | 'binding_ticket_ttl_seconds' | 'admin_daily_bind_limit' | 'timeout_ms' })[] = [
  {
    key: 'dingtalk.session_ttl_hours', storage: 'dingtalk', savePermission: 'platform-admin', group: 'login', column: 'session_ttl_seconds',
    label: '钉钉会话有效期', description: '过期后在钉钉内自动重新免登；有效期越短，离职与收权生效越快。',
    unit: '小时', defaultValue: 12, min: 1, max: 720, timing: '之后的免登', scale: 3600,
  },
  {
    key: 'dingtalk.binding_ticket_ttl_minutes', storage: 'dingtalk', savePermission: 'platform-admin', group: 'login', column: 'binding_ticket_ttl_seconds',
    label: '钉钉待绑定凭证有效期', description: '员工在钉钉内首次登录时生成的待绑定凭证的有效期。',
    unit: '分钟', defaultValue: 5, min: 1, max: 60, timing: '之后发出的凭证', scale: 60,
  },
  {
    key: 'dingtalk.admin_daily_bind_limit', storage: 'dingtalk', savePermission: 'platform-admin', group: 'login', column: 'admin_daily_bind_limit',
    label: '每位管理员每日代绑上限', description: '限制代绑次数；代绑可让操作人以员工身份在钉钉内登录（功能规则第 13 节已知风险）。',
    unit: '次', defaultValue: 50, min: 1, max: 10_000, timing: '立即', scale: 1,
  },
  {
    key: 'dingtalk.timeout_seconds', storage: 'dingtalk', savePermission: 'config', group: 'login', column: 'timeout_ms',
    label: '钉钉接口超时', description: '调用钉钉开放接口的超时。',
    unit: '秒', defaultValue: 10, min: 1, max: 60, timing: '立即', scale: 1000,
  },
]

/** Runtime 的两项（RP11）：每个 Runtime 一组，键带 Runtime ID；容量以 `runtimes.capacity` 为准。 */
export function runtimeSettingDefinitions(runtime: { id: string; name: string }): PlatformSettingDefinition[] {
  return [
    {
      key: `runtime.${runtime.id}.capacity`, storage: 'runtime', savePermission: 'config', group: 'runtime',
      label: `Runtime 容量（${runtime.name}）`, description: '同时执行的运行数，不能小于当前活动 Worker 数；后台任务合计最多用到容量减 1。',
      unit: '个', defaultValue: 2, min: 1, max: 128, timing: '立即',
    },
    {
      key: `runtime.${runtime.id}.timeout_minutes`, storage: 'runtime', savePermission: 'config', group: 'runtime',
      label: `Runtime 单次执行超时（${runtime.name}）`, description: '每次运行的上限；Agent 运行超时更长时按此截断。',
      unit: '分钟', defaultValue: 5, min: 1, max: 60, timing: '之后新建的运行', scale: 60,
    },
  ]
}

/** 解析 Runtime 参数键：`runtime.<id>.capacity` / `runtime.<id>.timeout_minutes`。 */
export function parseRuntimeSettingKey(key: string): { runtimeId: string; field: 'capacity' | 'timeout_minutes' } | null {
  const match = /^runtime\.([A-Za-z0-9_-]{1,120})\.(capacity|timeout_minutes)$/.exec(key)
  return match ? { runtimeId: match[1]!, field: match[2] as 'capacity' | 'timeout_minutes' } : null
}

const DEFINITIONS = new Map<string, PlatformSettingDefinition>([...PLATFORM_SETTING_DEFINITIONS, ...DINGTALK_PARAMETER_DEFINITIONS].map(definition => [definition.key, definition]))

export function platformSettingDefinition(key: string): PlatformSettingDefinition | undefined {
  return DEFINITIONS.get(key as PlatformSettingKey)
}

/** 某个键的保存权限：Runtime 的两项归平台配置；未登记的键返回 undefined（由服务层报未登记）。 */
export function settingSavePermission(key: string): PlatformSettingSavePermission | undefined {
  if (parseRuntimeSettingKey(key)) return 'config'
  return platformSettingDefinition(key)?.savePermission
}

/** 校验并规范化一个参数值：只接受登记范围内的整数。 */
export function validatePlatformSettingValue(key: string, value: unknown): number {
  const definition = platformSettingDefinition(key)
  if (!definition) throw invalidRequest(`未登记的运行参数：${key}`)
  return validateSettingValue(definition, value)
}

export function validateSettingValue(definition: PlatformSettingDefinition, value: unknown): number {
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

/**
 * 由数据库行构造读取口：值不合法或键未登记时回落到默认值。`initial` 为页面从未保存过（没有行）时的初始值
 * （例如登录会话有效期来自环境变量）；行的值为 null（恢复默认）时仍按登记默认值。
 */
export function platformSettingsFromValues(values: ReadonlyMap<string, unknown>, initial: Partial<Record<PlatformSettingKey, number>> = {}): PlatformSettingsReader {
  return {
    get(key) {
      const definition = DEFINITIONS.get(key)!
      if (!values.has(key) && initial[key] !== undefined) return initial[key]!
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
  key: string
  storage: PlatformSettingStorage
  savePermission: PlatformSettingSavePermission
  /** 乐观锁的分组：同一存储行的多项共用一个版本号，一次比对（`platform:<键>`、`runtime:<ID>`、`dingtalk`）。 */
  versionKey: string
  /** 为 false 时只读（如钉钉应用未配置），原因见 `unavailableReason`。 */
  available: boolean
  unavailableReason?: string
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
  belowDefaultRisk?: string
  raiseRisk?: string
  /** `page`：页面保存过；`default`：从未保存或已恢复默认，按默认值；`env`：部署配置给的初始值（钉钉四项）。 */
  source: 'page' | 'default' | 'env'
  /**
   * 存储值不是整页面单位时为 false（例如 1800 秒的钉钉会话有效期，页面单位为小时），`actual` 给出真实值；
   * 页面此时不预填数值，填入任何值都按修改处理（PR #180 评审 I4）。
   */
  exact: boolean
  actual?: string
  /** 乐观锁：从未保存时为 0；恢复默认后继续递增，不回到 0。 */
  revision: number
  updatedAt?: string
  updatedBy?: string
}

/** 通用视图：值、来源与版本由各存储读取后传入。 */
export function settingView(definition: PlatformSettingDefinition, state: {
  value: number
  source: 'page' | 'default' | 'env'
  exact?: boolean
  actual?: string
  revision: number
  versionKey: string
  available?: boolean
  unavailableReason?: string
  updatedAt?: string
  updatedBy?: string
}): PlatformSettingView {
  return {
    key: definition.key, storage: definition.storage, savePermission: definition.savePermission,
    versionKey: state.versionKey, available: state.available ?? true,
    ...(state.unavailableReason ? { unavailableReason: state.unavailableReason } : {}),
    group: definition.group, label: definition.label, description: definition.description,
    unit: definition.unit, value: state.value, defaultValue: definition.defaultValue,
    min: definition.min, max: definition.max, timing: definition.timing,
    ...(definition.lowerRisk ? { lowerRisk: definition.lowerRisk } : {}),
    ...(definition.belowDefaultRisk ? { belowDefaultRisk: definition.belowDefaultRisk } : {}),
    ...(definition.raiseRisk ? { raiseRisk: definition.raiseRisk } : {}),
    source: state.source,
    exact: state.exact ?? true,
    ...(state.actual ? { actual: state.actual } : {}),
    revision: state.revision,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    ...(state.updatedBy ? { updatedBy: state.updatedBy } : {}),
  }
}

/** `platform_settings` 中的一项；记录的值为 `null`（已恢复默认）或不合法时按默认值，来源为“默认值”。 */
export function platformSettingView(
  definition: PlatformSettingDefinition,
  saved?: { value: unknown; revision: number; updatedAt?: string; updatedBy?: string },
): PlatformSettingView {
  const value = saved?.value
  const valid = typeof value === 'number' && Number.isInteger(value) && value >= definition.min && value <= definition.max
  return settingView(definition, {
    value: valid ? value : definition.defaultValue,
    source: valid ? 'page' : 'default',
    revision: saved?.revision ?? 0,
    versionKey: `platform:${definition.key}`,
    ...(saved?.updatedAt ? { updatedAt: saved.updatedAt } : {}),
    ...(saved?.updatedBy ? { updatedBy: saved.updatedBy } : {}),
  })
}

/** 存储值换成页面值（向上取整，例如 90 秒的超时显示为 2 分钟）。 */
export function toPageValue(definition: PlatformSettingDefinition, stored: number) {
  return Math.ceil(stored / (definition.scale ?? 1))
}

/** 存储值是否为整页面单位；不是时给出真实值的文字（秒按时分秒，毫秒按毫秒）。 */
export function storedValueState(definition: PlatformSettingDefinition, stored: number): { exact: boolean; actual?: string } {
  const scale = definition.scale ?? 1
  if (stored % scale === 0) return { exact: true }
  if (scale === 1000) return { exact: false, actual: `${stored} 毫秒` }
  const hours = Math.floor(stored / 3600)
  const minutes = Math.floor((stored % 3600) / 60)
  const seconds = stored % 60
  return { exact: false, actual: [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分钟` : '', seconds ? `${seconds} 秒` : ''].filter(Boolean).join(' ') }
}

export interface PlatformSettingChange {
  key: string
  value: unknown
  revision: unknown
}

export function parsePlatformSettingChanges(body: unknown): PlatformSettingChange[] {
  const changes = (body as { changes?: unknown } | null)?.changes
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 64) {
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
