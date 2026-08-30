import type { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { envelope, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerModelGovernanceRoutes(router: Router, service: ModelGovernanceService) {
  router.get(`${basePath}/model-providers`, async () => envelope('admin', await service.listProviders()))
  router.post(`${basePath}/model-providers`, async (request) =>
    envelope('admin', await service.createProvider(await readJsonBody(request))),
  )
  router.patch(`${basePath}/model-providers/status`, async (request) =>
    envelope('admin', await service.setProviderStatus(await readJsonBody(request))),
  )
  router.post(`${basePath}/provider-models`, async (request) =>
    envelope('admin', await service.createProviderModel(await readJsonBody(request))),
  )
  router.patch(`${basePath}/model-providers/credential-reference`, async (request) =>
    envelope('admin', await service.upsertCredentialReference(await readJsonBody(request))),
  )
  router.get(`${basePath}/model-routes`, async () => envelope('admin', await service.listRoutes()))
  router.post(`${basePath}/model-routes`, async (request) =>
    envelope('admin', await service.createRoute(await readJsonBody(request))),
  )
  router.post(`${basePath}/model-routes/resolve`, async (request) => {
    const input = await readJsonBody<{ routeKey?: string }>(request)
    return envelope('admin', await service.resolveRoute(input.routeKey))
  })
}
