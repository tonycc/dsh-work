import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  ModelProvider,
  ModelRoute,
  ModelRouteSnapshot,
  ProviderStatus,
  UpsertCredentialReferenceInput,
} from './model-types.ts'

export interface ModelGovernanceRepository {
  listProviders(tenantId: string): Promise<ModelProvider[]>
  createProvider(tenantId: string, input: CreateProviderInput): Promise<ModelProvider>
  setProviderStatus(
    tenantId: string,
    providerId: string,
    status: ProviderStatus,
    actor: string,
  ): Promise<ModelProvider>
  createProviderModel(tenantId: string, input: CreateProviderModelInput): Promise<ModelProvider>
  upsertCredentialReference(
    tenantId: string,
    input: UpsertCredentialReferenceInput,
  ): Promise<ModelProvider>
  listRoutes(tenantId: string): Promise<ModelRoute[]>
  createRoute(tenantId: string, input: CreateModelRouteInput): Promise<ModelRoute>
  resolveRoute(tenantId: string, routeKey?: string): Promise<ModelRouteSnapshot>
}
