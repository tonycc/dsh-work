import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { envelope, httpResult, readJsonBody, type Router } from '../router.ts'
import type { CreateAgentDraftInput, PublishStatus, UpdateAgentDraftInput } from '../../domain/types.ts'

const basePath = '/api/admin/v1'

export function registerAgentRoutes(router: Router, service: PostgresAgentService) {
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents(), 'postgres'))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions(), 'postgres'))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/agents`, async request => httpResult(
    201,
    envelope('admin', await service.createAgent(await readJsonBody<CreateAgentDraftInput>(request)), 'postgres'),
  ))
  router.patch(`${basePath}/agents/draft`, async request => envelope(
    'admin',
    await service.updateAgent(await readJsonBody<UpdateAgentDraftInput>(request)),
    'postgres',
  ))
  router.post(`${basePath}/agents/test`, async request => envelope(
    'admin',
    await service.testAgent(await readJsonBody<{ agentId: string; prompt: string; actor: string }>(request)),
    'postgres',
  ))
  router.patch(`${basePath}/agents/status`, async request => envelope(
    'admin',
    await service.setStatus(await readJsonBody<{
      agentId: string
      status: Extract<PublishStatus, 'published' | 'disabled'>
      actor: string
    }>(request)),
    'postgres',
  ))
  router.post(`${basePath}/agents/rollback`, async request => envelope(
    'admin',
    await service.rollback(await readJsonBody<{ agentId: string; version: string; actor: string }>(request)),
    'postgres',
  ))
}
