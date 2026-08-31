import { describe, expect, it } from 'vitest'

import type { ModelUsageRecord } from '@/types/domain'
import { summarizeModelUsageByEmployee } from './model-usage'

describe('model usage employee summaries', () => {
  it('groups calls by employee and calculates successful-call latency', () => {
    const records: ModelUsageRecord[] = [
      usage({ id: 'usage-1', employeeId: 'U001', employeeName: '林岚', status: 'success', promptTokens: 100, completionTokens: 40, totalTokens: 140, latencyMs: 1200 }),
      usage({ id: 'usage-2', employeeId: 'U001', employeeName: '林岚', status: 'failed', promptTokens: 30, completionTokens: 0, totalTokens: 30, latencyMs: 30000 }),
      usage({ id: 'usage-3', employeeId: 'U002', employeeName: '周衡', status: 'success', promptTokens: 200, completionTokens: 100, totalTokens: 300, latencyMs: 1800 }),
    ]

    const summaries = summarizeModelUsageByEmployee(records)
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({
      employeeId: 'U002', callCount: 1, successCount: 1, successRate: 1,
      totalTokens: 300, averageLatencyMs: 1800,
    })
    expect(summaries[1]).toMatchObject({
      employeeId: 'U001', callCount: 2, successCount: 1, failedCount: 1, successRate: 0.5,
      promptTokens: 130, completionTokens: 40, totalTokens: 170, averageLatencyMs: 1200,
    })
  })
})

function usage(overrides: Partial<ModelUsageRecord> & Pick<ModelUsageRecord, 'id' | 'employeeId' | 'employeeName'>): ModelUsageRecord {
  return {
    time: '2026-08-31 10:00:00',
    runId: `run-${overrides.id}`,
    agentId: 'agent-dsh-work-assistant',
    department: '供应链中心',
    provider: '企业模型网关',
    model: 'DeepSeek-V3',
    modelRoute: 'default',
    status: 'success',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    traceId: `trace-${overrides.id}`,
    ...overrides,
  }
}
