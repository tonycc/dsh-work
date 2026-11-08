import type { ModelGatewayEndpoint, ModelGatewayRequestLog, ModelGatewayRequestRecord } from './model-gateway-types.ts'

/** 与 run 模块的 AttemptModelUsageLine 同构（结构类型，模块之间互不引用）。 */
export interface GatewayAttemptUsageLine {
  endpoint: ModelGatewayEndpoint
  providerKey: string
  modelKey: string
  requests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

/**
 * 按请求类型汇总一个 Attempt 的网关记录（模型路由方案 4.6）。
 * - 实际模型取厂商成功返回的请求；网关拒绝的记录保存的是请求方声明的模型，不能作为实际模型。
 * - token 只统计返回了用量的请求；缓存字段要求这些请求全部带有缓存数据，否则为 null。
 */
export function summarizeGatewayRequests(records: readonly ModelGatewayRequestRecord[]): GatewayAttemptUsageLine[] {
  const lines: GatewayAttemptUsageLine[] = []
  for (const endpoint of ['chat', 'search'] as const) {
    const items = records.filter(record => record.endpoint === endpoint)
    if (items.length === 0) continue
    const succeeded = items.filter(record => record.origin === 'upstream' && record.outcome === 'succeeded')
    const modelSource = succeeded.at(-1) ?? items.at(-1)!
    const reported = items.filter(record => record.inputTokens !== null || record.outputTokens !== null)
    const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0)
    const allReport = (pick: (record: ModelGatewayRequestRecord) => number | null) =>
      reported.length > 0 && reported.every(record => pick(record) !== null)
    lines.push({
      endpoint,
      providerKey: modelSource.providerKey,
      modelKey: modelSource.modelKey,
      requests: items.length,
      failedRequests: items.filter(record => record.outcome === 'failed').length,
      inputTokens: sum(reported.map(record => record.inputTokens)),
      outputTokens: sum(reported.map(record => record.outputTokens)),
      cacheReadTokens: allReport(record => record.cacheReadTokens) ? sum(reported.map(record => record.cacheReadTokens)) : null,
      cacheWriteTokens: allReport(record => record.cacheWriteTokens) ? sum(reported.map(record => record.cacheWriteTokens)) : null,
    })
  }
  return lines
}

/** 读取网关请求记录并按 Attempt 汇总，供运行结束时写入用量与结算预算。 */
export class ModelGatewayUsageMeter {
  private readonly log: Pick<ModelGatewayRequestLog, 'listForAttempt'>

  constructor(log: Pick<ModelGatewayRequestLog, 'listForAttempt'>) {
    this.log = log
  }

  async summarizeAttempt(tenantId: string, attemptId: string): Promise<GatewayAttemptUsageLine[]> {
    return summarizeGatewayRequests(await this.log.listForAttempt(tenantId, attemptId))
  }
}
