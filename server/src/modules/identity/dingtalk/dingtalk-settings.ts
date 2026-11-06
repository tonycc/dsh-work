import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresEncryptedCredentialStore } from '../../tool/postgres-encrypted-credential-store.ts'
import { IdentityAccessError } from '../auth-service.ts'
import { DINGTALK_DEFAULTS, type DingTalkConfiguration, type DingTalkDeploymentSettings } from './dingtalk-config.ts'
import { DingTalkDirectoryError, type DingTalkDirectory } from './dingtalk-directory.ts'
import { DingTalkOpenApiDirectory } from './dingtalk-open-api.ts'

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
  /** 已保存的 AppSecret 能否读取（主密钥丢失或更换后为 false，须重新填写）。 */
  secretReadable: boolean
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
  updatedAt: Date
  updatedByName: string | null
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

  /** 启动时：页面从未保存过（没有记录）时，用部署配置建立初始配置；部署配置变化时同步更新这份初始配置。 */
  async ensureBootstrap() {
    const bootstrap = this.deployment.bootstrap
    if (!bootstrap) return
    await this.database`
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
             secret_hint = excluded.secret_hint, session_ttl_seconds = excluded.session_ttl_seconds,
             binding_ticket_ttl_seconds = excluded.binding_ticket_ttl_seconds,
             admin_daily_bind_limit = excluded.admin_daily_bind_limit, timeout_ms = excluded.timeout_ms, updated_at = now()
       where dingtalk_app_configurations.source = 'deployment-config' and dingtalk_app_configurations.status = 'configured'
         and (dingtalk_app_configurations.corp_id, dingtalk_app_configurations.agent_id, dingtalk_app_configurations.app_key,
              dingtalk_app_configurations.secret_hint, dingtalk_app_configurations.session_ttl_seconds,
              dingtalk_app_configurations.binding_ticket_ttl_seconds, dingtalk_app_configurations.admin_daily_bind_limit,
              dingtalk_app_configurations.timeout_ms)
             is distinct from
             (excluded.corp_id, excluded.agent_id, excluded.app_key, excluded.secret_hint, excluded.session_ttl_seconds,
              excluded.binding_ticket_ttl_seconds, excluded.admin_daily_bind_limit, excluded.timeout_ms)
    `
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
      secretReadable: configured ? Boolean(await this.secret(row!)) : false,
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
    const sessionTtlSeconds = integerIn(input.sessionTtlSeconds, '钉钉会话有效期', 300, 2_592_000, DINGTALK_DEFAULTS.sessionTtlSeconds)
    const bindingTicketTtlSeconds = integerIn(input.bindingTicketTtlSeconds, '待绑定凭证有效期', 60, 3600, DINGTALK_DEFAULTS.bindingTicketTtlSeconds)
    const adminDailyBindLimit = integerIn(input.adminDailyBindLimit, '每日代绑上限', 1, 10_000, DINGTALK_DEFAULTS.adminDailyBindLimit)
    const timeoutMs = integerIn(input.timeoutMs, '接口超时', 1000, 60_000, DINGTALK_DEFAULTS.timeoutMs)
    const existing = await this.row()
    const sameApplication = existing?.status === 'configured' && existing.corpId === corpId && existing.appKey === appKey
    if (!appSecret && !sameApplication) {
      throw new IdentityAccessError(422, 'dingtalk_secret_required', existing?.status === 'configured' ? '更换 CorpId 或 AppKey 时须重新填写 AppSecret' : '首次配置须填写 AppSecret')
    }
    if (appSecret && !this.credentials) {
      throw new IdentityAccessError(409, 'credential_master_key_missing', '服务未配置 DSH_CREDENTIAL_MASTER_KEY，不能在页面保存 AppSecret，请联系部署人员')
    }
    const effectiveSecret = appSecret ?? (existing ? await this.secret(existing) : undefined)
    if (!effectiveSecret) {
      throw new IdentityAccessError(422, 'dingtalk_secret_required', '已保存的 AppSecret 无法读取（主密钥可能已更换），请重新填写')
    }
    const candidate: DingTalkConfiguration = {
      corpId, agentId, appKey, appSecret: effectiveSecret, apiBaseUrl: this.deployment.apiBaseUrl,
      timeoutMs, sessionTtlSeconds, bindingTicketTtlSeconds, adminDailyBindLimit,
    }
    // 钉钉调用在事务之外；凭据错误或出口 IP 未登记时不保存。
    try {
      await this.directoryFactory(candidate).checkCredentials()
    } catch (error) {
      if (error instanceof DingTalkDirectoryError && error.code === 'unavailable') {
        throw new IdentityAccessError(503, 'dingtalk_unavailable', `暂时无法连接钉钉，未保存：${error.message}`)
      }
      throw new IdentityAccessError(422, 'dingtalk_credentials_rejected', '钉钉拒绝了这组凭据：请核对 AppKey、AppSecret，并确认服务器出口 IP 已在钉钉后台登记。未保存')
    }
    await this.database.begin(async transaction => {
      if (appSecret) {
        await transaction`
          insert into credential_refs (id, tenant_id, backend, external_ref, status, last_verified_at, updated_by)
          values (${dingtalkCredentialRefId}, ${tenantId}, 'dsh-managed', 'dingtalk:app-secret', 'configured', now(), ${actorId})
          on conflict (id) do update set status = 'configured', last_verified_at = now(), updated_by = excluded.updated_by, updated_at = now()
        `
        const [secret] = await transaction<{ exists: boolean }[]>`
          select exists (select 1 from credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${dingtalkCredentialRefId}) as exists
        `
        const write = { tenantId, credentialRefId: dingtalkCredentialRefId, bearerToken: appSecret, actorId }
        if (secret?.exists) await this.credentials!.rotate(transaction, write)
        else await this.credentials!.create(transaction, write)
      }
      const credentialRef = appSecret ? dingtalkCredentialRefId : existing?.credentialRef ?? null
      const hint = appSecret ? secretHint(appSecret) : existing?.secretHint ?? null
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
               session_ttl_seconds = excluded.session_ttl_seconds, binding_ticket_ttl_seconds = excluded.binding_ticket_ttl_seconds,
               admin_daily_bind_limit = excluded.admin_daily_bind_limit, timeout_ms = excluded.timeout_ms,
               updated_by = excluded.updated_by, updated_at = now()
      `
      await settingsAudit(transaction, actorId, 'identity.dingtalk.settings.update', {
        corpId, agentId, appKey, secretChanged: String(Boolean(appSecret)),
        sessionTtlSeconds: String(sessionTtlSeconds), bindingTicketTtlSeconds: String(bindingTicketTtlSeconds),
        adminDailyBindLimit: String(adminDailyBindLimit), timeoutMs: String(timeoutMs),
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
             c.updated_at as "updatedAt", u.display_name as "updatedByName"
        from dingtalk_app_configurations c
        left join users u on u.tenant_id = c.tenant_id and u.id = c.updated_by
       where c.tenant_id = ${tenantId}
    `
    return row ?? null
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

function integerIn(value: unknown, label: string, min: number, max: number, fallback: number) {
  if (value === undefined || value === null || value === '') return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new IdentityAccessError(422, 'invalid_request', `${label}须为 ${min}–${max} 之间的整数`)
  }
  return number
}
