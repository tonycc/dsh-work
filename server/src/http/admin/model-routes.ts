import type { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerModelGovernanceRoutes(router: Router, service: ModelGovernanceService) {
  router.get(`${basePath}/model-providers`, async () => envelope('admin', await service.listProviders()))
  router.post(`${basePath}/model-providers`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<ModelGovernanceService['createProvider']>[0], 'actor'>>(request)
    return envelope('admin', await service.createProvider({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-providers/status`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<ModelGovernanceService['setProviderStatus']>[0], 'actor'>>(request)
    return envelope('admin', await service.setProviderStatus({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/provider-models`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<ModelGovernanceService['createProviderModel']>[0], 'actor'>>(request)
    return envelope('admin', await service.createProviderModel({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.patch(`${basePath}/model-providers/credential-reference`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<ModelGovernanceService['upsertCredentialReference']>[0], 'actor'>>(request)
    return envelope('admin', await service.upsertCredentialReference({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.get(`${basePath}/model-routes`, async () => envelope('admin', await service.listRoutes()))
  router.post(`${basePath}/model-routes`, async (request, context) => {
    const input = await readJsonBody<Omit<Parameters<ModelGovernanceService['createRoute']>[0], 'actor'>>(request)
    return envelope('admin', await service.createRoute({ ...input, actor: requireRequestIdentity(context, 'admin').userId }))
  })
  router.post(`${basePath}/model-routes/resolve`, async (request) => {
    const input = await readJsonBody<{ routeKey?: string }>(request)
    return envelope('admin', await service.resolveRoute(input.routeKey))
  })
}
