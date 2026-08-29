import type { AdminQueryService } from '../../modules/admin/application/admin-query-service.ts'
import { envelope, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerAdminRoutes(router: Router, service: AdminQueryService) {
  router.get(`${basePath}/session`, async () => envelope('admin', await service.getSession()))
  router.get(`${basePath}/tasks`, async () => envelope('admin', await service.getTaskSummaries()))
  router.get(`${basePath}/runtimes`, async () => envelope('admin', await service.getRuntimes()))
  router.post(`${basePath}/runtimes/check`, async (request) =>
    envelope('admin', await service.checkRuntime(await readJsonBody(request))),
  )
  router.patch(`${basePath}/runtimes/configuration`, async (request) =>
    envelope('admin', await service.updateRuntimeConfiguration(await readJsonBody(request))),
  )
  router.get(`${basePath}/sessions`, async () => envelope('admin', await service.getSessions()))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces()))
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents()))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions()))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getAgentReleaseRecords()))
  router.post(`${basePath}/agents`, async (request) =>
    envelope('admin', await service.createAgentDraft(await readJsonBody(request))),
  )
  router.patch(`${basePath}/agents/draft`, async (request) =>
    envelope('admin', await service.updateAgentDraft(await readJsonBody(request))),
  )
  router.patch(`${basePath}/agents/status`, async (request) =>
    envelope('admin', await service.setAgentStatus(await readJsonBody(request))),
  )
  router.post(`${basePath}/agents/rollback`, async (request) =>
    envelope('admin', await service.rollbackAgent(await readJsonBody(request))),
  )
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills()))
  router.post(`${basePath}/skills`, async (request) =>
    envelope('admin', await service.createSkill(await readJsonBody(request))),
  )
  router.patch(`${basePath}/skills`, async (request) =>
    envelope('admin', await service.updateSkill(await readJsonBody(request))),
  )
  router.patch(`${basePath}/skills/status`, async (request) =>
    envelope('admin', await service.setSkillStatus(await readJsonBody(request))),
  )
  router.get(`${basePath}/tools`, async () => envelope('admin', await service.getTools()))
  router.patch(`${basePath}/tools/status`, async (request) =>
    envelope('admin', await service.setToolStatus(await readJsonBody(request))),
  )
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors()))
  router.post(`${basePath}/connectors/check`, async (request) =>
    envelope('admin', await service.checkConnector(await readJsonBody(request))),
  )
  router.get(`${basePath}/roles`, async () => envelope('admin', await service.getRoles()))
  router.get(`${basePath}/members`, async () => envelope('admin', await service.getMembers()))
  router.patch(`${basePath}/roles`, async (request) =>
    envelope('admin', await service.updateRole(await readJsonBody(request))),
  )
  router.patch(`${basePath}/tools/permissions`, async (request) =>
    envelope('admin', await service.updateToolPermissions(await readJsonBody(request))),
  )
  router.get(`${basePath}/audit-events`, async () => envelope('admin', await service.getAuditEvents()))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth()))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage()))
  router.get(`${basePath}/model-usage`, async () => envelope('admin', await service.getModelUsage()))
  router.get(`${basePath}/platform-status`, () => envelope('admin', service.getPlatformStatus()))
}
