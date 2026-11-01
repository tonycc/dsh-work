import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 按 WeKnora v0.9.0 接口约定实现的测试替身（weknora-knowledge-plan 第 12 节）。只实现平台调用的
 * 检索、文档元数据与知识库管理接口，返回固定数据；仅用于测试，不是生产备用。
 */
export interface WeKnoraDoubleDocument {
  id: string
  knowledgeBaseId: string
  title: string
  fileName: string
  updatedAt: string
}

export interface WeKnoraDoubleChunk {
  id: string
  knowledgeId: string
  content: string
  score: number
}

export interface WeKnoraDoubleRequest {
  method: string
  path: string
  apiKey: string | undefined
  body: unknown
}

export class WeKnoraDouble {
  readonly apiKey: string
  readonly requests: WeKnoraDoubleRequest[] = []
  documents: WeKnoraDoubleDocument[] = []
  chunks: WeKnoraDoubleChunk[] = []
  /** 下一批请求返回的 HTTP 状态（模拟 5xx、401、429 等）；为空时正常响应。 */
  failWith: number | null = null
  /** 只让文档元数据接口失败。 */
  failBatchWith: number | null = null
  /** 响应前等待的毫秒数（模拟超时）。 */
  delayMs = 0
  /** 检索结果中省略 knowledge_base_id（WeKnora 中该字段为 omitempty）。 */
  omitKnowledgeBaseId = false
  /** 忽略请求中的知识库范围（模拟返回范围之外的分段，验证平台再校验）。 */
  ignoreKnowledgeBaseScope = false
  private server: Server | null = null
  private nextKnowledgeBase = 1

  constructor(apiKey = 'test-weknora-key') {
    this.apiKey = apiKey
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      })
    })
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server!.close(() => resolve()))
    this.server = null
  }

  reset() {
    this.requests.length = 0
    this.documents = []
    this.chunks = []
    this.failWith = null
    this.failBatchWith = null
    this.delayMs = 0
    this.omitKnowledgeBaseId = false
    this.ignoreKnowledgeBaseScope = false
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(request.url ?? '/', 'http://double')
    const raw = await readBody(request)
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined
    const apiKey = request.headers['x-api-key']
    this.requests.push({ method: request.method ?? 'GET', path: url.pathname, apiKey: Array.isArray(apiKey) ? apiKey[0] : apiKey, body })
    if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    if (apiKey !== this.apiKey) return { status: 401, body: { success: false, error: { code: 1001, message: 'unauthorized' } } }
    if (this.failWith) return { status: this.failWith, body: { success: false, error: { code: 1007, message: 'failure' } } }

    if (request.method === 'POST' && url.pathname === '/api/v1/knowledge-search') {
      const bases = new Set((body?.knowledge_base_ids as string[] | undefined) ?? [])
      const documents = new Map(this.documents.filter(document => this.ignoreKnowledgeBaseScope || bases.has(document.knowledgeBaseId)).map(document => [document.id, document]))
      const data = this.chunks
        .filter(chunk => documents.has(chunk.knowledgeId))
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(body?.match_count ?? 10))
        .map((chunk, index) => {
          const document = documents.get(chunk.knowledgeId)!
          return {
            id: chunk.id,
            content: chunk.content,
            knowledge_id: chunk.knowledgeId,
            chunk_index: index,
            knowledge_title: document.title,
            start_at: 0,
            end_at: chunk.content.length,
            seq: index,
            score: chunk.score,
            match_type: 0,
            sub_chunk_id: [],
            metadata: {},
            chunk_type: 'text',
            parent_chunk_id: '',
            image_info: '',
            knowledge_filename: document.fileName,
            knowledge_source: 'file',
            knowledge_channel: 'api',
            ...(this.omitKnowledgeBaseId ? {} : { knowledge_base_id: document.knowledgeBaseId }),
          }
        })
      return { status: 200, body: { success: true, data, meta: { rerank: { applied: false, outcome: 'disabled' } } } }
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/knowledge/batch') {
      if (this.failBatchWith) return { status: this.failBatchWith, body: { success: false, error: { code: 1007, message: 'failure' } } }
      const ids = new Set(url.searchParams.getAll('ids').flatMap(value => value.split(',')))
      const data = this.documents.filter(document => ids.has(document.id)).map(document => ({
        id: document.id,
        knowledge_base_id: document.knowledgeBaseId,
        title: document.title,
        file_name: document.fileName,
        parse_status: 'completed',
        updated_at: document.updatedAt,
      }))
      return { status: 200, body: { success: true, data } }
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/knowledge-bases') {
      if (typeof body?.name !== 'string' || !body.name) return { status: 400, body: { success: false, error: { code: 1010, message: 'name required' } } }
      const id = `kb-double-${this.nextKnowledgeBase++}`
      return { status: 201, body: { success: true, data: { id, name: body.name, type: body.type ?? 'document', embedding_model_id: body.embedding_model_id ?? '' } } }
    }
    const deleteBase = url.pathname.match(/^\/api\/v1\/knowledge-bases\/([^/]+)$/)
    if (request.method === 'DELETE' && deleteBase) {
      return { status: 200, body: { success: true, message: 'Knowledge base deleted successfully' } }
    }
    return { status: 404, body: { success: false, error: { code: 1003, message: 'not found' } } }
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
