import type { WorkbenchQueryService } from '../../modules/workbench/application/workbench-query-service.ts'
import { envelope, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

export function registerWorkbenchRoutes(router: Router, service: WorkbenchQueryService) {
  router.get(`${basePath}/session`, async () => envelope('workbench', await service.getSession()))
  router.get(`${basePath}/tasks`, async () => envelope('workbench', await service.getTasks()))
  router.get(`${basePath}/workspaces`, async () => envelope('workbench', await service.getWorkspaces()))
  router.get(`${basePath}/artifacts`, async () => envelope('workbench', await service.getArtifacts()))
  router.get(`${basePath}/agents`, async () => envelope('workbench', await service.getAgents()))
}
