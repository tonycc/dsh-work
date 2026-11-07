import { dependencyUnavailable } from '../../domain/request-errors.ts'

/** 厂商模型目录：管理端添加模型时列出厂商可用的模型 id，只作为输入建议，不参与执行。 */
export interface ProviderModelCatalogPort {
  list(input: { tenantId: string; credentialRefId: string; baseUrl: string }): Promise<string[]>
}

export interface HttpProviderModelCatalogOptions {
  /** 读取平台加密保存的厂商密钥（与模型网关同一来源）；密钥只在本进程内使用，不返回给浏览器。 */
  readSecret(tenantId: string, credentialRefId: string): Promise<string>
  fetch?: typeof fetch
  timeoutMs?: number
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 1000

/** 按 OpenAI 兼容协议请求 `{base_url}/models`；与网关转发 `{base_url}/chat/completions` 的拼接方式一致。 */
export class HttpProviderModelCatalog implements ProviderModelCatalogPort {
  private readonly options: HttpProviderModelCatalogOptions

  constructor(options: HttpProviderModelCatalogOptions) {
    this.options = options
  }

  async list(input: { tenantId: string; credentialRefId: string; baseUrl: string }): Promise<string[]> {
    let secret: string
    try {
      secret = await this.options.readSecret(input.tenantId, input.credentialRefId)
    } catch {
      throw dependencyUnavailable('无法读取该 Provider 的 API Key，请重新录入后再试')
    }
    const target = `${input.baseUrl.replace(/\/+$/, '')}/models`
    const doFetch = this.options.fetch ?? fetch
    let response: Response
    try {
      response = await doFetch(target, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
        redirect: 'error',
      })
    } catch {
      throw dependencyUnavailable('无法连接厂商获取模型列表，请检查 Base URL 与网络，或手动填写模型标识')
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel()
      throw dependencyUnavailable('厂商拒绝了该 API Key，请检查密钥后再试，或手动填写模型标识')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw dependencyUnavailable(`厂商未提供模型列表（HTTP ${response.status}），请手动填写模型标识`)
    }
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > MAX_RESPONSE_BYTES) {
      await response.body?.cancel()
      throw dependencyUnavailable('厂商返回的模型列表过大，请手动填写模型标识')
    }
    let payload: unknown
    try {
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('too large')
      payload = JSON.parse(text)
    } catch {
      throw dependencyUnavailable('厂商返回的模型列表无法解析，请手动填写模型标识')
    }
    return parseModelIds(payload)
  }
}

/** 兼容 `{data:[{id}]}`（OpenAI 标准）与 `{models:[{id|name}]}` 两种常见形态；去重、排序，最多 1000 个。 */
export function parseModelIds(payload: unknown): string[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const items = Array.isArray(record['data']) ? record['data'] : Array.isArray(record['models']) ? record['models'] : null
  if (!items) throw dependencyUnavailable('厂商返回的模型列表格式不符合 OpenAI 兼容协议，请手动填写模型标识')
  const ids = new Set<string>()
  for (const item of items) {
    const value = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? (item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name']
        : undefined
    if (typeof value === 'string' && value.trim() && value.length <= 200) ids.add(value.trim())
    if (ids.size >= MAX_MODELS) break
  }
  return [...ids].sort((left, right) => left.localeCompare(right))
}
