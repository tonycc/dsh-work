import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'
import type { CreateAgentDraftInput, PublishStatus, UpdateAgentDraftInput } from '../../domain/types.ts'

const basePath = '/api/admin/v1'

export function registerAgentRoutes(router: Router, service: PostgresAgentService) {
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents(), 'postgres'))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions(), 'postgres'))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/agents`, async (request, context) => {
    const input = await readJsonBody<Omit<CreateAgentDraftInput, 'actor'>>(request)
    return httpResult(201, envelope('admin', await service.createAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres'))
  })
  router.patch(`${basePath}/agents/draft`, async (request, context) => {
    const input = await readJsonBody<Omit<UpdateAgentDraftInput, 'actor'>>(request)
    return envelope('admin', await service.updateAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/agents/test`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; prompt: string }>(request)
    return envelope('admin', await service.testAgent({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.patch(`${basePath}/agents/status`, async (request, context) => {
    const input = await readJsonBody<{
      agentId: string
      status: Extract<PublishStatus, 'published' | 'disabled'>
    }>(request)
    return envelope('admin', await service.setStatus({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
  router.post(`${basePath}/agents/rollback`, async (request, context) => {
    const input = await readJsonBody<{ agentId: string; version: string }>(request)
    return envelope('admin', await service.rollback({
      ...input,
      actor: requireRequestIdentity(context, 'admin').userId,
    }), 'postgres')
  })
}
