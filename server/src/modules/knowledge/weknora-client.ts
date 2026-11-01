/**
 * WeKnora v0.9.0 HTTP 客户端（weknora-knowledge-plan 第 4 节）。只调用检索、文档元数据与知识库
 * 管理接口；WeKnora 的问答、Agent 与 MCP 一律不用（WK5）。API Key 只在这里进入请求头，
 * 错误信息不带 Key、请求正文或响应正文。
 */

export type WeKnoraFailureReason = 'timeout' | 'network' | 'auth' | 'rate_limited' | 'server' | 'protocol'

export class WeKnoraUnavailableError extends Error {
  readonly reason: WeKnoraFailureReason

  constructor(reason: WeKnoraFailureReason, message: string) {
    super(message)
    this.name = 'WeKnoraUnavailableError'
    this.reason = reason
  }
}

/** Request-level rejections (400/404/409) that are not an outage. */
export class WeKnoraRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WeKnoraRequestError'
    this.status = status
  }
}

export interface WeKnoraSearchResult {
  id: string
  content: string
  knowledge_id: string
  knowledge_base_id?: string
  knowledge_title: string
  knowledge_filename: string
  score: number
}

export interface WeKnoraKnowledge {
  id: string
  knowledge_base_id: string
  title: string
  file_name: string
  updated_at: string
}

export interface WeKnoraKnowledgeBase {
  id: string
  name: string
}

export interface WeKnoraClientConfig {
  baseUrl: string
  apiKey: string
  /** 检索超时（4.3）：5 秒，不重试。 */
  timeoutMs?: number
  fetch?: typeof fetch
}

export const weknoraSearchTimeoutMs = 5000

export class WeKnoraClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(config: WeKnoraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? weknoraSearchTimeoutMs
    this.fetchImpl = config.fetch ?? fetch
  }

  async search(input: { query: string; knowledgeBaseIds: string[]; matchCount: number }): Promise<WeKnoraSearchResult[]> {
    // rerank 不传：沿用 WeKnora 工作空间默认的重排序配置（4.3）。
    const body = await this.request('POST', '/api/v1/knowledge-search', {
      query: input.query,
      knowledge_base_ids: input.knowledgeBaseIds,
      match_count: input.matchCount,
    })
    const data = arrayData(body)
    return data.map(item => {
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.content !== 'string' || typeof row.knowledge_id !== 'string'
        || typeof row.score !== 'number') {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 检索结果缺少必要字段')
      }
      return {
        id: row.id,
        content: row.content,
        knowledge_id: row.knowledge_id,
        ...(typeof row.knowledge_base_id === 'string' ? { knowledge_base_id: row.knowledge_base_id } : {}),
        knowledge_title: typeof row.knowledge_title === 'string' ? row.knowledge_title : '',
        knowledge_filename: typeof row.knowledge_filename === 'string' ? row.knowledge_filename : '',
        score: row.score,
      }
    })
  }

  async knowledgeBatch(ids: string[]): Promise<WeKnoraKnowledge[]> {
    if (!ids.length) return []
    const query = new URLSearchParams()
    for (const id of ids) query.append('ids', id)
    const body = await this.request('GET', `/api/v1/knowledge/batch?${query.toString()}`)
    return arrayData(body).map(item => {
      const row = item as Record<string, unknown>
      if (typeof row.id !== 'string' || typeof row.knowledge_base_id !== 'string' || typeof row.updated_at !== 'string'
        || Number.isNaN(Date.parse(row.updated_at))) {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 文档元数据缺少必要字段')
      }
      return {
        id: row.id,
        knowledge_base_id: row.knowledge_base_id,
        title: typeof row.title === 'string' ? row.title : '',
        file_name: typeof row.file_name === 'string' ? row.file_name : '',
        updated_at: row.updated_at,
      }
    })
  }

  /** 新建文档型知识库并带上统一嵌入模型（4.6）。 */
  async createKnowledgeBase(input: { name: string; description: string; embeddingModelId: string }): Promise<WeKnoraKnowledgeBase> {
    const body = await this.request('POST', '/api/v1/knowledge-bases', {
      name: input.name,
      description: input.description,
      type: 'document',
      embedding_model_id: input.embeddingModelId,
    })
    const data = (body as { data?: Record<string, unknown> }).data
    if (!data || typeof data.id !== 'string') throw new WeKnoraUnavailableError('protocol', 'WeKnora 新建知识库响应缺少 ID')
    return { id: data.id, name: typeof data.name === 'string' ? data.name : input.name }
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    await this.request('DELETE', `/api/v1/knowledge-bases/${encodeURIComponent(id)}`)
  }

  private async request(method: string, path: string, json?: unknown): Promise<unknown> {
    const controller = new AbortController()
    // 超时覆盖连接与读取响应正文，避免慢响应拖住执行。
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            'X-API-Key': this.apiKey,
            accept: 'application/json',
            ...(json === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) throw new WeKnoraUnavailableError('timeout', 'WeKnora 请求超时')
        throw new WeKnoraUnavailableError('network', `WeKnora 连接失败：${error instanceof Error ? error.name : 'unknown'}`)
      }
      if (response.status === 401 || response.status === 403) throw new WeKnoraUnavailableError('auth', `WeKnora 认证失败（${response.status}）`)
      if (response.status === 429) throw new WeKnoraUnavailableError('rate_limited', 'WeKnora 限流（429）')
      if (response.status >= 500) throw new WeKnoraUnavailableError('server', `WeKnora 服务错误（${response.status}）`)
      if (response.status >= 400) throw new WeKnoraRequestError(response.status, `WeKnora 拒绝请求（${response.status}）`)
      let body: unknown
      try {
        body = await response.json()
      } catch {
        if (controller.signal.aborted) throw new WeKnoraUnavailableError('timeout', 'WeKnora 请求超时')
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应不是 JSON')
      }
      if (!body || typeof body !== 'object' || (body as { success?: unknown }).success === false) {
        throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应格式不符合约定')
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }
}

function arrayData(body: unknown): unknown[] {
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) throw new WeKnoraUnavailableError('protocol', 'WeKnora 响应缺少 data 列表')
  return data
}
