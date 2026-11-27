import { randomUUID } from 'node:crypto'

import { isAuthorizationDenial } from '../../domain/authorization-errors.ts'
import {
  DINGTALK_PARAMETER_DEFINITIONS,
  PLATFORM_SETTING_DEFINITIONS,
  parseRuntimeSettingKey,
  platformSettingDefinition,
  platformSettingView,
  platformSettingsFromValues,
  runtimeSettingDefinitions,
  settingView,
  toPageValue,
  validateSettingValue,
  type PlatformSettingChange,
  type PlatformSettingDefinition,
  type PlatformSettingKey,
  type PlatformSettingsReader,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import { accessDenied, invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { writeRuntimeCapacityAndTimeout } from '../admin/application/postgres-operations-service.ts'
import { requireAdminModuleActor, requirePlatformAdminOnly } from '../authorization/admin-actor.ts'
import { writeDingTalkParameters } from '../identity/dingtalk/dingtalk-settings.ts'
import {
  buildRuntimeParametersOverview,
  type DingTalkSummary,
  type RuntimeParameterOwner,
  type RuntimeParametersOverview,
  type RuntimeSummary,
} from './runtime-parameters-overview.ts'

const tenantId = 'tenant-dsh-work'

interface SettingRow {
  key: string
  value: unknown
  revision: number
  updatedAt: Date
  updatedBy: string
}

interface RuntimeRow extends RuntimeSummary {
  revision: number
}

interface DingTalkRow extends DingTalkSummary {
  status: 'configured' | 'cleared'
  revision: number
}

type ResolvedChange = { definition: PlatformSettingDefinition; value: number; revision: number; runtimeId?: string; field?: 'capacity' | 'timeout_minutes' }

/**
 * 平台配置（运行参数配置方案 RP-S1、RP-S2）：`platform_settings` 中的参数在热路径上同步读取进程内快照，保存后立即刷新；
 * Runtime 容量与超时、钉钉四项沿用原有存储，经同一接口在同一事务内读写（6.6.2）。
 */
export class PostgresPlatformSettingsService implements PlatformSettingsReader {
  private readonly database: DatabaseClient
  private readonly onDingTalkChanged?: () => void
  private snapshot: PlatformSettingsReader = platformSettingsFromValues(new Map())

  constructor(database: DatabaseClient, options: { onDingTalkChanged?: () => void } = {}) {
    this.database = database
    this.onDingTalkChanged = options.onDingTalkChanged
  }

  /** 启动时读取一次；之后由保存刷新。 */
  async load(): Promise<void> {
    const rows = await this.database<{ key: string; value: unknown }[]>`
      select key, value from platform_settings where tenant_id = ${tenantId}
    `
    this.snapshot = platformSettingsFromValues(new Map(rows.map(row => [row.key, row.value])))
  }

  get(key: PlatformSettingKey): number {
    return this.snapshot.get(key)
  }

  async list(): Promise<PlatformSettingView[]> {
    const [rows, runtimes, dingtalk] = await Promise.all([
      this.database<SettingRow[]>`
        select s.key, s.value, s.revision, s.updated_at as "updatedAt",
               coalesce(u.display_name, s.updated_by) as "updatedBy"
          from platform_settings s
          left join users u on u.tenant_id = s.tenant_id and u.id = s.updated_by
         where s.tenant_id = ${tenantId}
      `,
      this.runtimes(),
      this.dingtalkRow(),
    ])
    const saved = new Map(rows.map(row => [row.key, row]))
    const platform = PLATFORM_SETTING_DEFINITIONS.map(definition => {
      const row = saved.get(definition.key)
      return platformSettingView(definition, row && { value: row.value, revision: row.revision, updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy })
    })
    const runtime = runtimes.flatMap(item => runtimeSettingDefinitions(item).map(definition => settingView(definition, {
      value: definition.key.endsWith('.capacity') ? item.capacity : toPageValue(definition, item.timeoutSeconds),
      source: item.configured ? 'page' : 'default',
      revision: item.revision,
      versionKey: `runtime:${item.id}`,
    })))
    return [...platform, ...runtime, ...dingtalkViews(dingtalk)]
  }

  /**
   * 一次保存多项（同一事务）。保存权限先由路由对照表判定（`config` 修改），这里在事务内按每项保存权限复核：
   * 安全类只认平台管理员（`requirePlatformAdminOnly`，RP16），其余认“平台配置”修改权限（功能规则第 13 节“判定位置”）。
   * 每个存储行比对一次版本号：`platform_settings` 逐键；同一 Runtime 的容量与超时、钉钉四项各为一组。
   * 恢复默认时保留该行、值存 JSON `null`，版本号始终递增；值与当前生效值相同的项不写入、不记审计。
   */
  async save(changes: PlatformSettingChange[], actorId: string): Promise<PlatformSettingView[]> {
    const resolved = changes.map(resolveChange)
    const groups = new Map<string, ResolvedChange[]>()
    for (const change of resolved) {
      const versionKey = change.definition.storage === 'platform' ? `platform:${change.definition.key}`
        : change.definition.storage === 'runtime' ? `runtime:${change.runtimeId}` : 'dingtalk'
      const group = groups.get(versionKey) ?? []
      if (group.length && group[0]!.revision !== change.revision) throw invalidRequest('同一组参数的版本号不一致，请刷新后重试')
      groups.set(versionKey, [...group, change])
    }
    const traceId = `trace-platform-settings-${randomUUID()}`
    let dingtalkChanged = false
    await this.database.begin(async sql => {
      const permissions = new Set(resolved.map(change => change.definition.savePermission))
      if (permissions.has('platform-admin')) {
        await requirePlatformAdminOnly(sql, actorId, '登录会话与钉钉的安全类参数只有平台管理员可以修改').catch(error => {
          throw isAuthorizationDenial(error) ? accessDenied(error instanceof Error ? error.message : '只有平台管理员可以修改') : error
        })
      }
      if (permissions.has('config')) {
        await requireAdminModuleActor(sql, actorId, 'config', 'write').catch(error => {
          throw isAuthorizationDenial(error) ? accessDenied('当前用户没有平台配置的修改权限') : error
        })
      }
      for (const [versionKey, group] of groups) {
        const storage = group[0]!.definition.storage
        if (storage === 'platform') await this.savePlatform(sql, group[0]!, actorId, traceId)
        else if (storage === 'runtime') {
          const capacity = group.find(change => change.field === 'capacity')?.value
          const minutes = group.find(change => change.field === 'timeout_minutes')?.value
          await writeRuntimeCapacityAndTimeout(sql, {
            runtimeId: versionKey.slice('runtime:'.length),
            ...(capacity === undefined ? {} : { capacity }),
            ...(minutes === undefined ? {} : { timeoutSeconds: minutes * 60 }),
            expectedRevision: group[0]!.revision,
            actorId,
          })
        } else {
          const values: Record<string, number> = {}
          for (const change of group) {
            const definition = DINGTALK_PARAMETER_DEFINITIONS.find(item => item.key === change.definition.key)!
            values[columnField[definition.column]] = change.value * (definition.scale ?? 1)
          }
          dingtalkChanged = (await writeDingTalkParameters(sql, { values, expectedRevision: group[0]!.revision, actorId })).changed
        }
      }
    })
    if (dingtalkChanged) this.onDingTalkChanged?.()
    await this.load()
    return this.list()
  }

  private async savePlatform(sql: DatabaseTransaction, change: ResolvedChange, actorId: string, traceId: string) {
    const { definition, value, revision } = change
    const conflict = () => stateConflict(`“${definition.label}”已被其他管理员修改，请刷新后重试`)
    const [current] = await sql<{ value: unknown; revision: number }[]>`
      select value, revision from platform_settings
       where tenant_id = ${tenantId} and key = ${definition.key} for update
    `
    if ((current?.revision ?? 0) !== revision) throw conflict()
    const previous = typeof current?.value === 'number' ? current.value : definition.defaultValue
    if (value === previous) return
    const stored = value === definition.defaultValue ? sql`'null'::jsonb` : sql`${sql.json(value)}`
    if (current) {
      await sql`
        update platform_settings set value = ${stored}, revision = revision + 1, updated_by = ${actorId}, updated_at = now()
         where tenant_id = ${tenantId} and key = ${definition.key}
      `
    } else {
      // 第一次保存时没有行可锁：两个并发请求都读到版本 0，后插入者在这里落空，按冲突返回而不是主键错误。
      const inserted = await sql`
        insert into platform_settings (tenant_id, key, value, revision, updated_by)
        values (${tenantId}, ${definition.key}, ${stored}, 1, ${actorId})
        on conflict (tenant_id, key) do nothing
      `
      if (inserted.count === 0) throw conflict()
    }
    await sql`
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
      values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, 'platform.setting.update',
        'platform_setting', ${definition.key}, 'success', ${traceId},
        ${sql.json({ label: definition.label, from: String(previous), to: String(value), unit: definition.unit })})
    `
  }

  /** 参数总览（RP8）：只读，按白名单汇总各模块参数与超时链路，不返回任何密钥。 */
  async overview(input: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview> {
    const [settings, runtimes] = await Promise.all([this.list(), this.runtimes()])
    return buildRuntimeParametersOverview({ settings, runtimes, sessionTtl: input.sessionTtl, canEdit: input.canEdit })
  }

  private async runtimes(): Promise<RuntimeRow[]> {
    return this.database<RuntimeRow[]>`
      with configured as (
        select r.id, r.node_name as name, r.capacity, r.scheduling_status,
               latest.revision is not null as configured,
               coalesce(latest.revision, 0)::integer as revision,
               coalesce(latest.timeout_seconds, 300)::integer as "timeoutSeconds"
          from runtimes r
          left join lateral (
            select revision, timeout_seconds from runtime_configurations c
             where c.tenant_id = r.tenant_id and c.runtime_id = r.id order by revision desc limit 1
          ) latest on true
         where r.tenant_id = ${tenantId}
      )
      select c.id, c.name, c.capacity, c."timeoutSeconds", c.configured, c.revision,
             (select count(*)::integer from agents a
                join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
               where a.tenant_id = ${tenantId} and a.status = 'published'
                 and av.timeout_seconds > c."timeoutSeconds") as "agentsOverTimeout"
        from configured c
       order by (c.scheduling_status = 'accepting') desc, c.id
    `
  }

  private async dingtalkRow(): Promise<DingTalkRow | null> {
    const [row] = await this.database<DingTalkRow[]>`
      select status, source, session_ttl_seconds as "sessionTtlSeconds", binding_ticket_ttl_seconds as "bindingTicketTtlSeconds",
             admin_daily_bind_limit as "adminDailyBindLimit", timeout_ms as "timeoutMs", parameters_revision as revision
        from dingtalk_app_configurations
       where tenant_id = ${tenantId}
    `
    return row ?? null
  }
}

const columnField = {
  session_ttl_seconds: 'sessionTtlSeconds',
  binding_ticket_ttl_seconds: 'bindingTicketTtlSeconds',
  admin_daily_bind_limit: 'adminDailyBindLimit',
  timeout_ms: 'timeoutMs',
} as const

/** 钉钉四项的视图：应用未配置或已清除时只读并说明原因。 */
export function dingtalkViews(row: (DingTalkSummary & { status: 'configured' | 'cleared'; revision: number }) | null): PlatformSettingView[] {
  const configured = row?.status === 'configured'
  return DINGTALK_PARAMETER_DEFINITIONS.map(definition => settingView(definition, {
    value: row ? toPageValue(definition, row[columnField[definition.column]]) : definition.defaultValue,
    source: row?.source === 'admin' || row?.revision && row.revision > 1 ? 'page' : 'default',
    revision: row?.revision ?? 0,
    versionKey: 'dingtalk',
    available: configured,
    ...(configured ? {} : { unavailableReason: '钉钉应用尚未配置，配置后才能修改' }),
  }))
}

function resolveChange(change: PlatformSettingChange): ResolvedChange {
  const runtimeKey = parseRuntimeSettingKey(change.key)
  const definition = runtimeKey
    ? runtimeSettingDefinitions({ id: runtimeKey.runtimeId, name: runtimeKey.runtimeId }).find(item => item.key === change.key)
    : platformSettingDefinition(change.key)
  if (!definition) throw invalidRequest(`未登记的运行参数：${change.key}`)
  if (typeof change.revision !== 'number' || !Number.isInteger(change.revision) || change.revision < 0) {
    throw invalidRequest(`“${definition.label}”缺少版本号，请刷新后重试`)
  }
  return {
    definition, value: validateSettingValue(definition, change.value), revision: change.revision,
    ...(runtimeKey ? { runtimeId: runtimeKey.runtimeId, field: runtimeKey.field } : {}),
  }
}
