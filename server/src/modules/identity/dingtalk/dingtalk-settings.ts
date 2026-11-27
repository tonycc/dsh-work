import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresEncryptedCredentialStore } from '../../tool/postgres-encrypted-credential-store.ts'
import { IdentityAccessError } from '../request-security.ts'
import { DINGTALK_DEFAULTS, type DingTalkConfiguration, type DingTalkDeploymentSettings } from './dingtalk-config.ts'
import { DingTalkDirectoryError, type DingTalkDirectory } from './dingtalk-directory.ts'
import { DingTalkOpenApiDirectory } from './dingtalk-open-api.ts'
import { invalidateAllBindingsForCorpChange } from './dingtalk-bindings.ts'

const tenantId = 'tenant-dsh-work'
export const dingtalkCredentialRefId = 'credential-dingtalk-app-secret'

/**
 * 钉钉应用配置的读取端口：免登、代绑、离职检查、员工端都在每次使用时读取当前配置，
 * 管理端保存后立即生效，无需重启。未配置时返回 null（钉钉功能明确显示“未启用”，不降级）。
 */
export interface DingTalkSettingsProvider {
  current(): Promise<DingTalkConfiguration | null>
  directory(configuration: DingTalkConfiguration): DingTalkDirectory
}

/** 管理端编辑钉钉应用配置（平台管理员校验由调用方完成）。 */
export interface DingTalkSettingsManager {
  view(): Promise<DingTalkSettingsView>
  save(input: DingTalkSettingsInput, actorId: string): Promise<DingTalkSettingsView>
  clear(actorId: string): Promise<DingTalkSettingsView>
}

/** 测试与 P0 冒烟用：固定配置与固定目录实现。生产启动不使用。 */
export function staticDingTalkSettings(configuration: DingTalkConfiguration | null, directory: DingTalkDirectory): DingTalkSettingsProvider {
  return { current: async () => configuration, directory: () => directory }
}

/** 管理端“钉钉集成 › 应用配置”看到的内容：不含 AppSecret，只有后 4 位。 */
export interface DingTalkSettingsView {
  configured: boolean
  /** deployment-config：来自部署配置 DSH_WORK_DINGTALK_*（页面从未保存过）；admin：页面保存。 */
  source: 'deployment-config' | 'admin' | null
  corpId: string | null
  agentId: string | null
  appKey: string | null
  secretHint: string | null
  /** 已保存的 AppSecret 能否读取；不能读取时 `secretProblem` 说明原因。 */
  secretReadable: boolean
  /** deployment_secret_missing：仍依赖部署配置的 AppSecret，但部署配置已删除；master_key：加密保存的 AppSecret 无法用当前主密钥解密。 */
  secretProblem: 'deployment_secret_missing' | 'master_key' | null
  sessionTtlSeconds: number
  bindingTicketTtlSeconds: number
  adminDailyBindLimit: number
  timeoutMs: number
  /** 服务是否配置了 DSH_CREDENTIAL_MASTER_KEY；没有时页面不能保存 AppSecret。 */
  canStoreSecret: boolean
  updatedAt: string | null
  updatedByName: string | null
}

export interface DingTalkSettingsInput {
  corpId?: unknown
  agentId?: unknown
  appKey?: unknown
  appSecret?: unknown
  sessionTtlSeconds?: unknown
  bindingTicketTtlSeconds?: unknown
  adminDailyBindLimit?: unknown
  timeoutMs?: unknown
}

interface SettingsRow {
  status: 'configured' | 'cleared'
  source: 'deployment-config' | 'admin'
  corpId: string | null
  agentId: string | null
  appKey: string | null
  credentialRef: string | null
  secretHint: string | null
  sessionTtlSeconds: number
  bindingTicketTtlSeconds: number
  adminDailyBindLimit: number
  timeoutMs: number
  parametersRevision: number
  updatedAt: Date
  updatedByName: string | null
}

/** 平台配置中的钉钉四项（存储单位：秒、毫秒）与其修订号。 */
export interface DingTalkParameters {
  configured: boolean
  sessionTtlSeconds: number
  bindingTicketTtlSeconds: number
  adminDailyBindLimit: number
  timeoutMs: number
  revision: number
  source: 'deployment-config' | 'admin'
  updatedAt: string
  updatedByName: string | null
}

/**
 * 平台配置写入钉钉四项（运行参数配置方案 6.6.2）：调用方已在同一事务内判定保存权限（三项安全类只限平台管理员）。
 * 只更新这四列与修订号，不重新校验凭据；应用未配置或已清除时拒绝。写入后调用方须清除配置缓存（`invalidate`）。
 */
export async function writeDingTalkParameters(transaction: DatabaseTransaction, input: {
  values: Partial<Pick<DingTalkParameters, 'sessionTtlSeconds' | 'bindingTicketTtlSeconds' | 'adminDailyBindLimit' | 'timeoutMs'>>
  expectedRevision: number
  actorId: string
}): Promise<{ changed: boolean }> {
  const [row] = await transaction<{ status: string; revision: number; sessionTtlSeconds: number; bindingTicketTtlSeconds: number; adminDailyBindLimit: number; timeoutMs: number }[]>`
    select status, parameters_revision as revision, session_ttl_seconds as "sessionTtlSeconds",
           binding_ticket_ttl_seconds as "bindingTicketTtlSeconds", admin_daily_bind_limit as "adminDailyBindLimit", timeout_ms as "timeoutMs"
      from dingtalk_app_configurations where tenant_id = ${tenantId} for update
  `
  if (!row || row.status !== 'configured') throw new IdentityAccessError(409, 'dingtalk_not_configured', '钉钉应用尚未配置，不能修改这些参数')
  if (row.revision !== input.expectedRevision) throw new IdentityAccessError(409, 'state_conflict', '钉钉参数已被其他管理员修改，请刷新后重试')
  const next = {
    sessionTtlSeconds: input.values.sessionTtlSeconds ?? row.sessionTtlSeconds,
    bindingTicketTtlSeconds: input.values.bindingTicketTtlSeconds ?? row.bindingTicketTtlSeconds,
    adminDailyBindLimit: input.values.adminDailyBindLimit ?? row.adminDailyBindLimit,
    timeoutMs: input.values.timeoutMs ?? row.timeoutMs,
  }
  if (next.sessionTtlSeconds === row.sessionTtlSeconds && next.bindingTicketTtlSeconds === row.bindingTicketTtlSeconds
    && next.adminDailyBindLimit === row.adminDailyBindLimit && next.timeoutMs === row.timeoutMs) return { changed: false }
  await transaction`
    update dingtalk_app_configurations
       set session_ttl_seconds = ${next.sessionTtlSeconds}, binding_ticket_ttl_seconds = ${next.bindingTicketTtlSeconds},
           admin_daily_bind_limit = ${next.adminDailyBindLimit}, timeout_ms = ${next.timeoutMs},
           parameters_revision = parameters_revision + 1, updated_by = ${input.actorId}, updated_at = now()
     where tenant_id = ${tenantId}
  `
  await settingsAudit(transaction, input.actorId, 'identity.dingtalk.parameters.update', {
    sessionTtlSeconds: `${row.sessionTtlSeconds} → ${next.sessionTtlSeconds}`,
    bindingTicketTtlSeconds: `${row.bindingTicketTtlSeconds} → ${next.bindingTicketTtlSeconds}`,
    adminDailyBindLimit: `${row.adminDailyBindLimit} → ${next.adminDailyBindLimit}`,
    timeoutMs: `${row.timeoutMs} → ${next.timeoutMs}`,
    via: 'platform-config',
  })
  return { changed: true }
}

/**
 * 钉钉应用配置（2026-11-06 改为管理端填写）。AppSecret 以 DSH_CREDENTIAL_MASTER_KEY 加密存入
 * credential_secrets（与 MCP Token、WeKnora API Key 相同），不回显。部署配置 DSH_WORK_DINGTALK_* 只在页面从未
 * 保存过时作为初始配置；开放平台地址 DSH_WORK_DINGTALK_API_BASE_URL 只能由部署配置（AppSecret 会发往该地址）。
 */
export class DingTalkSettingsService implements DingTalkSettingsProvider, DingTalkSettingsManager {
  private readonly database: DatabaseClient
  private readonly credentials: PostgresEncryptedCredentialStore | undefined
  private readonly deployment: DingTalkDeploymentSettings
  private readonly directoryFactory: (configuration: DingTalkConfiguration) => DingTalkDirectory
  private cached: { value: DingTalkConfiguration | null; loadedAt: number } | null = null
  private directories = new Map<string, DingTalkDirectory>()

  constructor(database: DatabaseClient, options: {
    credentials?: PostgresEncryptedCredentialStore
    deployment: DingTalkDeploymentSettings
    directoryFactory?: (configuration: DingTalkConfiguration) => DingTalkDirectory
  }) {
    this.database = database
    this.credentials = options.credentials
    this.deployment = options.deployment
    this.directoryFactory = options.directoryFactory ?? (configuration => new DingTalkOpenApiDirectory(configuration))
  }

  /**
   * 启动时：页面从未保存过（没有记录）时，用部署配置建立初始配置；部署配置的凭据变化时同步更新这份初始配置。
   * 会话有效期、待绑定凭证有效期、每日代绑上限与接口超时只在首次建立时取部署配置，之后在“平台配置”中修改，
   * 启动时不再覆盖（运行参数配置方案 6.6.2：环境变量只作初始值）。
   */
  async ensureBootstrap() {
    const raw = this.deployment.bootstrap
    if (!raw) return
    // 旧部署配置只要求正整数；超出页面允许范围的值收进范围并告警，不阻止启动。
    const bootstrap = { ...raw, ...clampToPageRanges(raw) }
    await this.database.begin(async transaction => {
      const [previous] = await transaction<{ corpId: string | null; source: string; status: string }[]>`
        select corp_id as "corpId", source, status from dingtalk_app_configurations where tenant_id = ${tenantId} for update
      `
      await transaction`
        insert into dingtalk_app_configurations (
          tenant_id, status, source, corp_id, agent_id, app_key, credential_ref, secret_hint,
          session_ttl_seconds, binding_ticket_ttl_seconds, admin_daily_bind_limit, timeout_ms
        ) values (
          ${tenantId}, 'configured', 'deployment-config', ${bootstrap.corpId}, ${bootstrap.agentId}, ${bootstrap.appKey}, null,
          ${secretHint(bootstrap.appSecret)}, ${bootstrap.sessionTtlSeconds}, ${bootstrap.bindingTicketTtlSeconds},
          ${bootstrap.adminDailyBindLimit}, ${bootstrap.timeoutMs}
        )
        on conflict (tenant_id) do update
           set corp_id = excluded.corp_id, agent_id = excluded.agent_id, app_key = excluded.app_key,
               secret_hint = excluded.secret_hint, updated_at = now()
         where dingtalk_app_configurations.source = 'deployment-config' and dingtalk_app_configurations.status = 'configured'
           and (dingtalk_app_configurations.corp_id, dingtalk_app_configurations.agent_id, dingtalk_app_configurations.app_key,
                dingtalk_app_configurations.secret_hint)
               is distinct from
               (excluded.corp_id, excluded.agent_id, excluded.app_key, excluded.secret_hint)
      `
      // 部署配置换了企业：钉钉 userid 只在企业内唯一，旧企业的绑定必须失效。
      if (previous?.source === 'deployment-config' && previous.status === 'configured' && previous.corpId && previous.corpId !== bootstrap.corpId) {
        await invalidateAllBindingsForCorpChange(transaction)
      }
    })
    this.cached = null
  }

  async current(): Promise<DingTalkConfiguration | null> {
    // 单进程部署：保存时清除缓存；短时缓存只用来避免同一请求内反复读库。
    if (this.cached && Date.now() - this.cached.loadedAt < 5_000) return this.cached.value
    const row = await this.row()
    let value: DingTalkConfiguration | null = null
    if (row?.status === 'configured' && row.corpId && row.agentId && row.appKey) {
      const appSecret = await this.secret(row)
      if (appSecret) {
        value = {
          corpId: row.corpId, agentId: row.agentId, appKey: row.appKey, appSecret,
          apiBaseUrl: this.deployment.apiBaseUrl,
          timeoutMs: row.timeoutMs, sessionTtlSeconds: row.sessionTtlSeconds,
          bindingTicketTtlSeconds: row.bindingTicketTtlSeconds, adminDailyBindLimit: row.adminDailyBindLimit,
        }
      }
    }
    this.cached = { value, loadedAt: Date.now() }
    return value
  }

  /** 平台配置写入后清除缓存，下一次读取即用新值。 */
  invalidate() {
    this.cached = null
  }

  /** 同一份配置复用同一个客户端（保留 access_token 缓存）；配置变化后换新客户端。 */
  directory(configuration: DingTalkConfiguration): DingTalkDirectory {
    const key = [configuration.corpId, configuration.appKey, configuration.appSecret, configuration.apiBaseUrl, configuration.timeoutMs].join('\u0000')
    let directory = this.directories.get(key)
    if (!directory) {
      this.directories = new Map([[key, directory = this.directoryFactory(configuration)]])
    }
    return directory
  }

  async view(): Promise<DingTalkSettingsView> {
    const row = await this.row()
    const configured = row?.status === 'configured'
    return {
      configured,
      source: configured ? row!.source : null,
      corpId: configured ? row!.corpId : null,
      agentId: configured ? row!.agentId : null,
      appKey: configured ? row!.appKey : null,
      secretHint: configured ? row!.secretHint : null,
      ...await this.secretState(configured ? row : null),
      sessionTtlSeconds: row?.sessionTtlSeconds ?? DINGTALK_DEFAULTS.sessionTtlSeconds,
      bindingTicketTtlSeconds: row?.bindingTicketTtlSeconds ?? DINGTALK_DEFAULTS.bindingTicketTtlSeconds,
      adminDailyBindLimit: row?.adminDailyBindLimit ?? DINGTALK_DEFAULTS.adminDailyBindLimit,
      timeoutMs: row?.timeoutMs ?? DINGTALK_DEFAULTS.timeoutMs,
      canStoreSecret: Boolean(this.credentials),
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedByName: row?.updatedByName ?? null,
    }
  }

  /**
   * 保存：先用这组凭据向钉钉换取 access_token，失败不保存。更换 CorpId 或 AppKey 时必须重新填写 AppSecret，
   * 已保存的 AppSecret 只用于原来的应用。调用方已校验平台管理员身份。
   */
  async save(input: DingTalkSettingsInput, actorId: string): Promise<DingTalkSettingsView> {
    const corpId = requiredText(input.corpId, 'CorpId', 64)
    const agentId = requiredText(input.agentId, 'AgentId', 64)
    const appKey = requiredText(input.appKey, 'AppKey', 128)
    const appSecret = optionalSecret(input.appSecret)
    // 运行参数配置方案 6.6.2：四项改在“平台配置”中修改，这里带上即拒绝；保存凭据时沿用现值（首次配置用默认值）。
    if (input.sessionTtlSeconds !== undefined || input.bindingTicketTtlSeconds !== undefined
      || input.adminDailyBindLimit !== undefined || input.timeoutMs !== undefined) {
      throw new IdentityAccessError(422, 'invalid_request', '钉钉会话有效期、待绑定凭证有效期、每日代绑上限与接口超时已改在“平台配置”中修改')
    }
    const existing = await this.row()
    const sessionTtlSeconds = existing?.sessionTtlSeconds ?? DINGTALK_DEFAULTS.sessionTtlSeconds
    const bindingTicketTtlSeconds = existing?.bindingTicketTtlSeconds ?? DINGTALK_DEFAULTS.bindingTicketTtlSeconds
    const adminDailyBindLimit = existing?.adminDailyBindLimit ?? DINGTALK_DEFAULTS.adminDailyBindLimit
    const timeoutMs = existing?.timeoutMs ?? DINGTALK_DEFAULTS.timeoutMs
    const sameApplication = existing?.status === 'configured' && existing.corpId === corpId && existing.appKey === appKey
    if (!appSecret && !sameApplication) {
      throw new IdentityAccessError(422, 'dingtalk_secret_required', existing?.status === 'configured' ? '更换 CorpId 或 AppKey 时须重新填写 AppSecret' : '首次配置须填写 AppSecret')
    }
    if (appSecret && !this.credentials) {
      throw new IdentityAccessError(409, 'credential_master_key_missing', '服务未配置 DSH_CREDENTIAL_MASTER_KEY，不能在页面保存 AppSecret，请联系部署人员')
    }
    const effectiveSecret = appSecret ?? (existing ? await this.secret(existing) : undefined)
    if (!effectiveSecret) {
      throw new IdentityAccessError(422, 'dingtalk_secret_required', existing && !existing.credentialRef
        ? 'AppSecret 来自部署配置，但部署配置中已没有它，请重新填写'
        : '已保存的 AppSecret 无法读取（凭据主密钥可能已更换），请重新填写')
    }
    // 仍依赖部署配置的 AppSecret 时，页面保存一次就把它加密入库，之后不再依赖部署配置。
    const secretToStore = appSecret ?? (existing && !existing.credentialRef && this.credentials ? effectiveSecret : undefined)
    const candidate: DingTalkConfiguration = {
      corpId, agentId, appKey, appSecret: effectiveSecret, apiBaseUrl: this.deployment.apiBaseUrl,
      timeoutMs, sessionTtlSeconds, bindingTicketTtlSeconds, adminDailyBindLimit,
    }
    // 钉钉调用在事务之外；凭据错误或出口 IP 未登记时不保存。
    try {
      await this.directory(candidate).checkCredentials()
    } catch (error) {
      if (error instanceof DingTalkDirectoryError && error.code === 'unavailable') {
        throw new IdentityAccessError(503, 'dingtalk_unavailable', `暂时无法连接钉钉，未保存：${error.message}`)
      }
      throw new IdentityAccessError(422, 'dingtalk_credentials_rejected', '钉钉拒绝了这组凭据：请核对 AppKey、AppSecret，并确认服务器出口 IP 已在钉钉后台登记。未保存')
    }
    await this.database.begin(async transaction => {
      // 锁定后复核：验证期间配置被清除或改动时不保存，避免写回指向已删除密钥的配置。
      const [locked] = await transaction<{
        status: string; corpId: string | null; appKey: string | null; credentialRef: string | null
        sessionTtlSeconds: number; bindingTicketTtlSeconds: number; adminDailyBindLimit: number; timeoutMs: number
      }[]>`
        select status, corp_id as "corpId", app_key as "appKey", credential_ref as "credentialRef",
               session_ttl_seconds as "sessionTtlSeconds", binding_ticket_ttl_seconds as "bindingTicketTtlSeconds",
               admin_daily_bind_limit as "adminDailyBindLimit", timeout_ms as "timeoutMs"
          from dingtalk_app_configurations where tenant_id = ${tenantId} for update
      `
      if ((locked?.status ?? null) !== (existing?.status ?? null) || (locked?.corpId ?? null) !== (existing?.corpId ?? null)
        || (locked?.appKey ?? null) !== (existing?.appKey ?? null) || (locked?.credentialRef ?? null) !== (existing?.credentialRef ?? null)) {
        throw new IdentityAccessError(409, 'dingtalk_settings_changed', '钉钉应用配置刚被其他管理员修改，请刷新后重试')
      }
      if (secretToStore) {
        await transaction`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${dingtalkCredentialRefId}, ${tenantId}, 'dsh-managed', 'dingtalk:app-secret', 'configured', now(), ${actorId})
          on conflict (id) do update set status = 'configured', last_verified_at = now(), updated_by = excluded.updated_by, updated_at = now()
        `
        const [secret] = await transaction<{ exists: boolean }[]>`
          select exists (select 1 from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${dingtalkCredentialRefId}) as exists
        `
        const write = { tenantId, credentialRefId: dingtalkCredentialRefId, bearerToken: secretToStore, actorId }
        if (secret?.exists) await this.credentials!.rotate(transaction, write)
        else await this.credentials!.create(transaction, write)
      }
      const credentialRef = secretToStore ? dingtalkCredentialRefId : existing?.credentialRef ?? null
      const hint = secretToStore ? secretHint(secretToStore) : existing?.secretHint ?? null
      // 换了企业：钉钉 userid 只在企业内唯一，旧企业的绑定与待绑定凭证全部失效，钉钉会话一并撤销。
      const corpChanged = existing?.status === 'configured' && Boolean(existing.corpId) && existing.corpId !== corpId
      const invalidatedBindings = corpChanged ? await invalidateAllBindingsForCorpChange(transaction) : 0
      await transaction`
        insert into dingtalk_app_configurations (
          tenant_id, status, source, corp_id, agent_id, app_key, credential_ref, secret_hint,
          session_ttl_seconds, binding_ticket_ttl_seconds, admin_daily_bind_limit, timeout_ms, updated_by
        ) values (
          ${tenantId}, 'configured', 'admin', ${corpId}, ${agentId}, ${appKey}, ${credentialRef}, ${hint},
          ${sessionTtlSeconds}, ${bindingTicketTtlSeconds}, ${adminDailyBindLimit}, ${timeoutMs}, ${actorId}
        )
        on conflict (tenant_id) do update
           set status = 'configured', source = 'admin', corp_id = excluded.corp_id, agent_id = excluded.agent_id,
               app_key = excluded.app_key, credential_ref = excluded.credential_ref, secret_hint = excluded.secret_hint,
               updated_by = excluded.updated_by, updated_at = now()
        -- 四项参数在“平台配置”中修改（运行参数配置方案 6.6.2）：已有行时不覆盖，避免校验期间平台配置的修改被旧值改回。
      `
      await settingsAudit(transaction, actorId, 'identity.dingtalk.settings.update', {
        corpId, agentId, appKey, secretChanged: String(Boolean(appSecret)), secretStored: String(Boolean(secretToStore)),
        ...(corpChanged ? { previousCorpId: existing!.corpId!, invalidatedBindings: String(invalidatedBindings) } : {}),
        sessionTtlSeconds: String(locked?.sessionTtlSeconds ?? sessionTtlSeconds), bindingTicketTtlSeconds: String(locked?.bindingTicketTtlSeconds ?? bindingTicketTtlSeconds),
        adminDailyBindLimit: String(locked?.adminDailyBindLimit ?? adminDailyBindLimit), timeoutMs: String(locked?.timeoutMs ?? timeoutMs),
      })
    })
    this.cached = null
    return this.view()
  }

  /** 清除配置：钉钉免登、代绑与离职检查立即停用（显示“未启用”）。已有绑定记录保留；部署配置不会自动重新生效。 */
  async clear(actorId: string): Promise<DingTalkSettingsView> {
    await this.database.begin(async transaction => {
      await transaction`
        insert into dingtalk_app_configurations (tenant_id, status, source, updated_by)
        values (${tenantId}, 'cleared', 'admin', ${actorId})
        on conflict (tenant_id) do update
           set status = 'cleared', source = 'admin', corp_id = null, agent_id = null, app_key = null,
               credential_ref = null, secret_hint = null, updated_by = excluded.updated_by, updated_at = now()
      `
      await transaction`delete from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${dingtalkCredentialRefId}`
      await transaction`
        update credential_refs set status = 'revoked', updated_by = ${actorId}, updated_at = now()
         where tenant_id = ${tenantId} and id = ${dingtalkCredentialRefId}
      `
      await settingsAudit(transaction, actorId, 'identity.dingtalk.settings.clear', {})
    })
    this.cached = null
    this.directories.clear()
    return this.view()
  }

  private async row(): Promise<SettingsRow | null> {
    const [row] = await this.database<SettingsRow[]>`
      select c.status, c.source, c.corp_id as "corpId", c.agent_id as "agentId", c.app_key as "appKey",
             c.credential_ref as "credentialRef", c.secret_hint as "secretHint",
             c.session_ttl_seconds as "sessionTtlSeconds", c.binding_ticket_ttl_seconds as "bindingTicketTtlSeconds",
             c.admin_daily_bind_limit as "adminDailyBindLimit", c.timeout_ms as "timeoutMs",
             c.parameters_revision as "parametersRevision",
             c.updated_at as "updatedAt", u.display_name as "updatedByName"
        from dingtalk_app_configurations c
        left join users u on u.tenant_id = c.tenant_id and u.id = c.updated_by
       where c.tenant_id = ${tenantId}
    `
    return row ?? null
  }

  private async secretState(row: SettingsRow | null): Promise<Pick<DingTalkSettingsView, 'secretReadable' | 'secretProblem'>> {
    if (!row) return { secretReadable: false, secretProblem: null }
    if (await this.secret(row)) return { secretReadable: true, secretProblem: null }
    return { secretReadable: false, secretProblem: row.credentialRef ? 'master_key' : 'deployment_secret_missing' }
  }

  private async secret(row: SettingsRow): Promise<string | undefined> {
    if (!row.credentialRef) return this.deployment.bootstrap?.appSecret
    if (!this.credentials) return undefined
    try {
      return await this.credentials.readBearerToken(tenantId, row.credentialRef)
    } catch {
      console.warn('DingTalk AppSecret cannot be read from the credential store')
      return undefined
    }
  }
}

async function settingsAudit(database: DatabaseClient | DatabaseTransaction, actorId: string, action: string, context: Record<string, string>) {
  await database`
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id, result, trace_id, safe_context)
    values (${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${actorId}, ${action}, 'dingtalk_settings', ${tenantId},
      'success', ${`trace-dingtalk-${randomUUID()}`}, ${database.json({ channel: 'dingtalk', ...context })})
  `
}

function clampToPageRanges(configuration: DingTalkConfiguration) {
  const clamp = (value: number, min: number, max: number, name: string) => {
    const clamped = Math.min(max, Math.max(min, value))
    if (clamped !== value) console.warn(`${name}=${value} 超出范围 ${min}–${max}，已按 ${clamped} 使用；可在管理端“平台配置”中调整`)
    return clamped
  }
  return {
    sessionTtlSeconds: clamp(configuration.sessionTtlSeconds, 300, 2_592_000, 'DSH_WORK_DINGTALK_SESSION_TTL_SECONDS'),
    bindingTicketTtlSeconds: clamp(configuration.bindingTicketTtlSeconds, 60, 3600, 'DSH_WORK_DINGTALK_BINDING_TICKET_TTL_SECONDS'),
    adminDailyBindLimit: clamp(configuration.adminDailyBindLimit, 1, 10_000, 'DSH_WORK_DINGTALK_ADMIN_DAILY_BIND_LIMIT'),
    timeoutMs: clamp(configuration.timeoutMs, 1000, 60_000, 'DSH_WORK_DINGTALK_TIMEOUT_MS'),
  }
}

function secretHint(secret: string) {
  return secret.length > 8 ? secret.slice(-4) : null
}

function requiredText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim()) throw new IdentityAccessError(422, 'invalid_request', `请填写 ${label}`)
  const text = value.trim()
  if (text.length > max || /\s/.test(text)) throw new IdentityAccessError(422, 'invalid_request', `${label} 不能包含空格，且不超过 ${max} 个字符`)
  return text
}

function optionalSecret(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 512 || /\s/.test(value.trim())) {
    throw new IdentityAccessError(422, 'invalid_request', 'AppSecret 不能包含空格，且不超过 512 个字符')
  }
  return value.trim()
}

