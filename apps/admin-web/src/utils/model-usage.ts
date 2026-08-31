import type { ModelUsageRecord } from '@/types/domain'

export interface EmployeeModelUsageSummary {
  employeeId: string
  employeeName: string
  department: string
  callCount: number
  successCount: number
  failedCount: number
  blockedCount: number
  successRate: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  averageLatencyMs: number
  lastUsedAt: string
}

export function summarizeModelUsageByEmployee(records: ModelUsageRecord[]): EmployeeModelUsageSummary[] {
  const summaries = new Map<string, EmployeeModelUsageSummary>()
  const successfulLatencyTotals = new Map<string, number>()

  for (const record of records) {
    const current = summaries.get(record.employeeId) ?? {
      employeeId: record.employeeId,
      employeeName: record.employeeName,
      department: record.department,
      callCount: 0,
      successCount: 0,
      failedCount: 0,
      blockedCount: 0,
      successRate: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      averageLatencyMs: 0,
      lastUsedAt: record.time,
    }

    current.callCount += 1
    current.promptTokens += record.promptTokens
    current.completionTokens += record.completionTokens
    current.totalTokens += record.totalTokens

    if (record.status === 'success') {
      current.successCount += 1
      successfulLatencyTotals.set(
        record.employeeId,
        (successfulLatencyTotals.get(record.employeeId) ?? 0) + record.latencyMs,
      )
    } else if (record.status === 'failed') {
      current.failedCount += 1
    } else {
      current.blockedCount += 1
    }

    current.successRate = current.callCount ? current.successCount / current.callCount : 0
    current.averageLatencyMs = current.successCount
      ? Math.round((successfulLatencyTotals.get(record.employeeId) ?? 0) / current.successCount)
      : 0
    summaries.set(record.employeeId, current)
  }

  return [...summaries.values()]
    .sort((left, right) => right.totalTokens - left.totalTokens || left.employeeName.localeCompare(right.employeeName, 'zh-CN'))
}
