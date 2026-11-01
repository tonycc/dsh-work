import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresEncryptedCredentialStore } from '../tool/postgres-encrypted-credential-store.ts'
import { WeKnoraClient } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'
export const knowledgeConnectionId = 'knowledge-connection-weknora'
export const knowledgeCredentialRefId = 'credential-weknora-api-key'

/** 部署配置（WEKNORA_*）提供的初始连接；管理员在管理端保存 API Key 后不再使用其中的 Key。 */
export interface KnowledgeConnectionBootstrap {
  baseUrl: string
  apiKey: string
  embeddingModelId?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

interface ConnectionRow {
  baseUrl: string
  credentialRef: string | null
  embeddingModelId: string | null
  status: string
  updatedAt: Date
}

/**
 * 企业知识库连接（weknora-knowledge-plan 第 9 节，WK-S3）：管理端保存的地址、加密 API Key 与统一嵌入模型
 * 是唯一来源，检索链路与员工端每次调用前读取，保存后立即生效。连接停用、未配置或凭据不可读时没有客户端。
 */
export class PostgresKnowledgeConnection {
  readonly connectionId = knowledgeConnectionId
  private readonly database: DatabaseClient
  private readonly credentials: PostgresEncryptedCredentialStore | undefined
  private readonly bootstrap: KnowledgeConnectionBootstrap | undefined
  private cached: { key: string; client: WeKnoraClient } | null = null

  constructor(database: DatabaseClient, options: { credentials?: PostgresEncryptedCredentialStore; bootstrap?: KnowledgeConnectionBootstrap } = {}) {
    this.database = database
    this.credentials = options.credentials
    this.bootstrap = options.bootstrap
  }

  /**
   * 启动时按部署配置写入连接：还没有连接时新建；连接仍由部署配置管理（管理员从未保存过）时同步地址与嵌入模型。
   * 管理员保存过任何配置后，部署配置不再覆盖，重启不会撤销管理端的修改。
   */
  async ensureBootstrap(): Promise<void> {
    if (!this.bootstrap) return
    const hint = this.bootstrap.apiKey.length > 8 ? this.bootstrap.apiKey.slice(-4) : null
    await this.database`
      insert into external_knowledge_connections (id, tenant_id, base_url, credential_hint, embedding_model_id, updated_by)
      values (${this.connectionId}, ${tenantId}, ${this.bootstrap.baseUrl}, ${hint}, ${this.bootstrap.embeddingModelId ?? null}, 'deployment-config')
      on conflict (tenant_id) do update
         set base_url = excluded.base_url,
             credential_hint = excluded.credential_hint,
             embedding_model_id = excluded.embedding_model_id,
             updated_by = excluded.updated_by,
             updated_at = now()
       where external_knowledge_connections.credential_ref is null
         and external_knowledge_connections.updated_by = 'deployment-config'
    `
  }

  /** 有效连接的客户端；未配置、已停用或凭据不可读时为 null。 */
  async client(): Promise<WeKnoraClient | null> {
    const row = await this.row()
    if (!row || row.status !== 'active') return null
    const apiKey = await this.apiKey(row)
    if (!apiKey) return null
    const key = `${row.baseUrl}|${row.updatedAt.toISOString()}|${apiKey.length}`
    if (this.cached?.key !== key) {
      this.cached = {
        key,
        client: new WeKnoraClient({ baseUrl: row.baseUrl, apiKey, timeoutMs: this.bootstrap?.timeoutMs, fetch: this.bootstrap?.fetch }),
      }
    }
    return this.cached.client
  }

  async embeddingModelId(): Promise<string | undefined> {
    return (await this.row())?.embeddingModelId ?? undefined
  }

  /**
   * 用给定的地址与 Key（缺省为已保存的）建立一次性客户端，供“测试连接”使用。已保存的 Key 只发往已保存的地址：
   * 测试其他地址必须同时填写 Key，避免把只写不读的 Key 发到输错或不受信任的主机。
   */
  async probeClient(input: { baseUrl?: string; apiKey?: string }): Promise<{ client: WeKnoraClient } | { reason: 'not_configured' | 'api_key_required' }> {
    const row = await this.row()
    const baseUrl = input.baseUrl ?? row?.baseUrl
    if (!baseUrl) return { reason: 'not_configured' }
    if (!input.apiKey && row && baseUrl !== row.baseUrl) return { reason: 'api_key_required' }
    const apiKey = input.apiKey ?? (row ? await this.apiKey(row) : undefined)
    if (!apiKey) return { reason: 'not_configured' }
    return { client: new WeKnoraClient({ baseUrl, apiKey, timeoutMs: this.bootstrap?.timeoutMs, fetch: this.bootstrap?.fetch }) }
  }

  /** 已保存的地址；用于判断更换地址时是否填写了新 Key。 */
  async savedBaseUrl(): Promise<string | undefined> {
    return (await this.row())?.baseUrl
  }

  private async row(): Promise<ConnectionRow | undefined> {
    const [row] = await this.database<ConnectionRow[]>`
      select base_url as "baseUrl", credential_ref as "credentialRef", embedding_model_id as "embeddingModelId",
             status, updated_at as "updatedAt"
        from external_knowledge_connections where tenant_id = ${tenantId} and id = ${this.connectionId}
    `
    return row
  }

  private async apiKey(row: ConnectionRow): Promise<string | undefined> {
    if (!row.credentialRef) return this.bootstrap?.apiKey
    if (!this.credentials) return undefined
    try {
      return await this.credentials.readBearerToken(tenantId, row.credentialRef)
    } catch {
      // 凭据缺失或无法解密时按未配置处理，不把错误细节带到检索链路。
      console.warn('WeKnora API Key cannot be read from the credential store')
      return undefined
    }
  }
}
