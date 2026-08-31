import { randomUUID } from 'node:crypto'

import { httpResult, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Prototype mode keeps read-only review data available, but it cannot execute a
 * real conversation. Register the command surface explicitly so a missing
 * database is reported as a configuration problem rather than a version skew.
 */
export function registerUnavailableWorkbenchCommandRoutes(router: Router) {
  router.post(`${basePath}/sessions`, async () => unavailable('对话'))
  router.post(`${basePath}/sessions/:sessionId/runs`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''}`))
  router.post(`${basePath}/sessions/:sessionId/files`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''} 的文件`))
  router.get(`${basePath}/runs/:runId`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.get(`${basePath}/runs/:runId/events`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.post(`${basePath}/runs/:runId/cancel`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.post(`${basePath}/runs/:runId/retry`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
}

function unavailable(object: string) {
  return httpResult(503, {
    error: {
      code: 'workbench_runtime_not_configured',
      message: '当前服务未连接 PostgreSQL 和 DSH 运行时，不能创建或执行真实对话',
      object,
      suggestion: '在项目根目录配置 DSH_WORK_DATABASE_URL 后重启服务端；健康接口应显示 postgres-foundation。',
      traceId: `trace-http-${randomUUID()}`,
    },
  })
}
