import type { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { envelope, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'
const userId = 'U00001'

export function registerWorkbenchAgentRoutes(
  router: Router,
  service: PostgresAgentService,
  authorization?: PostgresAuthorizationService,
) {
  router.get(`${basePath}/agents`, async () => {
    await authorization?.authorizeWorkbench({ userId })
    return envelope('workbench', await service.listWorkbenchAgents(userId), 'postgres')
  })
}
