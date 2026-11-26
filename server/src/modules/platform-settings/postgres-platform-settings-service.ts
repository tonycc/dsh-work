import { randomUUID } from 'node:crypto'

import {
  PLATFORM_SETTING_DEFINITIONS,
  platformSettingDefinition,
  platformSettingsFromValues,
  validatePlatformSettingValue,
  type PlatformSettingChange,
  type PlatformSettingKey,
  type PlatformSettingsReader,
  type PlatformSettingView,
} from '../../domain/platform-settings.ts'
import { invalidRequest, stateConflict } from '../../domain/request-errors.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
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

/**
 * 运行参数（运行参数配置方案 RP-S1）：页面保存过的值存 `platform_settings`，其余按登记表默认值。
 * 运维参数在热路径上同步读取进程内快照；保存成功后立即刷新快照（单进程部署，方案第 2 节）。
 */
export class PostgresPlatformSettingsService implements PlatformSettingsReader {
  private readonly database: DatabaseClient
  private snapshot: PlatformSettingsReader = platformSettingsFromValues(new Map())

  constructor(database: DatabaseClient) {
    this.database = database
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
    const rows = await this.database<SettingRow[]>`
      select s.key, s.value, s.revision, s.updated_at as "updatedAt",
             coalesce(u.display_name, s.updated_by) as "updatedBy"
        from platform_settings s
        left join users u on u.tenant_id = s.tenant_id and u.id = s.updated_by
       where s.tenant_id = ${tenantId}
    `
    const saved = new Map(rows.map(row => [row.key, row]))
    const reader = platformSettingsFromValues(new Map(rows.map(row => [row.key, row.value])))
    return PLATFORM_SETTING_DEFINITIONS.map(definition => {
      const row = saved.get(definition.key)
      return {
        key: definition.key, group: definition.group, label: definition.label, description: definition.description,
        unit: definition.unit, value: reader.get(definition.key), defaultValue: definition.defaultValue,
        min: definition.min, max: definition.max, timing: definition.timing,
        ...(definition.lowerRisk ? { lowerRisk: definition.lowerRisk } : {}),
        source: row ? 'page' : 'default',
        revision: row?.revision ?? 0,
        ...(row ? { updatedAt: row.updatedAt.toISOString(), updatedBy: row.updatedBy } : {}),
      }
    })
  }

  /**
   * 一次保存多项（同一事务、逐项乐观锁）；值等于默认值时删除保存的记录（来源回到“默认值”）。保存权限由路由对照表判定（RP10，功能规则第 13 节），
   * 这里只校验值与版本，并逐项写审计 `platform.setting.update`。
   */
  async save(changes: PlatformSettingChange[], actorId: string): Promise<PlatformSettingView[]> {
    const validated = changes.map(change => {
      const definition = platformSettingDefinition(change.key)
      if (!definition) throw invalidRequest(`未登记的运行参数：${change.key}`)
      if (typeof change.revision !== 'number' || !Number.isInteger(change.revision) || change.revision < 0) {
        throw invalidRequest(`“${definition.label}”缺少版本号，请刷新后重试`)
      }
      return { definition, value: validatePlatformSettingValue(change.key, change.value), revision: change.revision }
    })
    const traceId = `trace-platform-settings-${randomUUID()}`
    await this.database.begin(async sql => {
      for (const { definition, value, revision } of validated) {
        const [current] = await sql<{ value: unknown; revision: number }[]>`
          select value, revision from platform_settings
           where tenant_id = ${tenantId} and key = ${definition.key} for update
        `
        if ((current?.revision ?? 0) !== revision) {
          throw stateConflict(`“${definition.label}”已被其他管理员修改，请刷新后重试`)
        }
        const previous = current ? current.value : definition.defaultValue
        if (value === definition.defaultValue) {
          // 恢复默认：删除保存的值，来源回到“默认值”（方案第 5 节：恢复默认回到系统默认）。
          await sql`delete from platform_settings where tenant_id = ${tenantId} and key = ${definition.key}`
        } else if (current) {
          await sql`
            update platform_settings set value = ${sql.json(value)}, revision = revision + 1, updated_by = ${actorId}, updated_at = now()
             where tenant_id = ${tenantId} and key = ${definition.key}
          `
        } else {
          await sql`
            insert into platform_settings (tenant_id, key, value, revision, updated_by)
            values (${tenantId}, ${definition.key}, ${sql.json(value)}, 1, ${actorId})
          `
        }
        await sql`
          insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
          values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, 'platform.setting.update',
            'platform_setting', ${definition.key}, 'success', ${traceId},
            ${sql.json({ label: definition.label, from: String(previous), to: String(value), unit: definition.unit })})
        `
      }
    })
    await this.load()
    return this.list()
  }

  /** 参数总览（RP8）：只读，按白名单汇总各模块参数与超时链路，不返回任何密钥。 */
  async overview(input: {
    sessionTtl: { seconds: number; fromEnvironment: boolean }
    canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
  }): Promise<RuntimeParametersOverview> {
    const [settings, runtimes, dingtalk] = await Promise.all([this.list(), this.runtimes(), this.dingtalk()])
    return buildRuntimeParametersOverview({ settings, runtimes, dingtalk, sessionTtl: input.sessionTtl, canEdit: input.canEdit })
  }

  private async runtimes(): Promise<RuntimeSummary[]> {
    return this.database<RuntimeSummary[]>`
      with configured as (
        select r.id, r.node_name as name, r.capacity, r.scheduling_status,
               coalesce((select timeout_seconds from runtime_configurations c
                          where c.tenant_id = r.tenant_id and c.runtime_id = r.id
                          order by revision desc limit 1), 300)::integer as "timeoutSeconds"
          from runtimes r
         where r.tenant_id = ${tenantId}
      )
      select c.id, c.name, c.capacity, c."timeoutSeconds",
             (select count(*)::integer from agents a
                join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
               where a.tenant_id = ${tenantId} and a.status = 'published'
                 and av.timeout_seconds > c."timeoutSeconds") as "agentsOverTimeout"
        from configured c
       order by (c.scheduling_status = 'accepting') desc, c.id
    `
  }

  private async dingtalk(): Promise<DingTalkSummary | null> {
    const [row] = await this.database<DingTalkSummary[]>`
      select source, session_ttl_seconds as "sessionTtlSeconds", binding_ticket_ttl_seconds as "bindingTicketTtlSeconds",
             admin_daily_bind_limit as "adminDailyBindLimit", timeout_ms as "timeoutMs"
        from dingtalk_app_configurations
       where tenant_id = ${tenantId} and status = 'configured'
    `
    return row ?? null
  }
}
