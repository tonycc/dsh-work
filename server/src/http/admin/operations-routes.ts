import type { PostgresOperationsService } from '../../modules/admin/application/postgres-operations-service.ts'
import { envelope, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerOperationsRoutes(router: Router, service: PostgresOperationsService) {
  router.get(`${basePath}/tasks`, async () => envelope('admin', await service.getTaskSummaries(), 'postgres'))
  router.get(`${basePath}/runtimes`, async () => envelope('admin', await service.getRuntimes(), 'postgres'))
  router.post(`${basePath}/runtimes/check`, async (request) =>
    envelope('admin', await service.checkRuntime(await readJsonBody(request)), 'postgres'))
  router.patch(`${basePath}/runtimes/configuration`, async (request) =>
    envelope('admin', await service.updateRuntimeConfiguration(await readJsonBody(request)), 'postgres'))
  router.get(`${basePath}/sessions`, async () => envelope('admin', await service.getSessions(), 'postgres'))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces(), 'postgres'))
  router.get(`${basePath}/audit-events`, async () => envelope('admin', await service.getAuditEvents(), 'postgres'))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth(), 'postgres'))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage(), 'postgres'))
  router.get(`${basePath}/model-usage`, async () => envelope('admin', await service.getModelUsage(), 'postgres'))
  router.get(`${basePath}/platform-status`, () => envelope('admin', service.getPlatformStatus(), 'postgres'))
}
