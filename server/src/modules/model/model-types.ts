export type ProviderStatus = 'active' | 'disabled'
export type CredentialStatus = 'configured' | 'missing' | 'revoked'
export type CredentialBackend = 'dsh-managed' | 'keychain' | 'secret-manager'
export type ModelStatus = 'active' | 'disabled'
/** 路由用途只保留默认路由（模型路由方案 R2、4.8）。 */
export type ModelRoutePurpose = 'default'
/** Provider 协议类型，全部经 DSH pi-ai 接入（模型路由方案 4.3）。 */
export type ProviderType = 'openai-completions' | 'openai-responses' | 'anthropic-messages'
/** Provider 信任级别：内部部署 / 外部厂商（数据防护方案 D4、5.5）。 */
export type ProviderTrustLevel = 'internal' | 'external'

export const providerTypes: readonly ProviderType[] = ['openai-completions', 'openai-responses', 'anthropic-messages']
/** 首批只开放 OpenAI Chat Completions 兼容协议；其余类型待探针覆盖后开放。 */
export const creatableProviderTypes: readonly ProviderType[] = ['openai-completions']
export const providerTrustLevels: readonly ProviderTrustLevel[] = ['internal', 'external']

export interface CredentialReference {
  id: string
  backend: CredentialBackend
  externalRef: string
  status: CredentialStatus
  lastVerifiedAt: string | null
  updatedAt: string
}

export interface ProviderModel {
  id: string
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  status: ModelStatus
}

export interface ModelProvider {
  id: string
  key: string
  name: string
  providerType: ProviderType
  trustLevel: ProviderTrustLevel
  baseUrl: string
  status: ProviderStatus
  credential: CredentialReference | null
  models: ProviderModel[]
  updatedAt: string
}

export interface ModelRoute {
  id: string
  key: string
  name: string
  purpose: ModelRoutePurpose
  providerModelId: string
  providerId: string
  providerName: string
  modelKey: string
  modelName: string
  priority: number
  enabled: boolean
  updatedAt: string
}

export interface ModelRouteSnapshot {
  routeId: string
  routeKey: string
  providerId: string
  providerKey: string
  providerType: ProviderType
  trustLevel: ProviderTrustLevel
  baseUrl: string
  modelId: string
  modelKey: string
  credentialRefId: string
  modelCapabilities: string[]
  credentialBackend: CredentialBackend
  credentialExternalRef: string
  resolvedAt: string
}

export interface CreateProviderInput {
  key: string
  name: string
  providerType: ProviderType
  trustLevel: ProviderTrustLevel
  baseUrl: string
  actor: string
}

export interface UpdateProviderInput {
  providerId: string
  name: string
  baseUrl: string
  trustLevel: ProviderTrustLevel
  actor: string
}

export interface CreateProviderModelInput {
  providerId: string
  modelKey: string
  displayName: string
  capabilities: string[]
  actor: string
}

export interface SetProviderModelStatusInput {
  modelId: string
  status: ModelStatus
  actor: string
}

export interface UpsertCredentialReferenceInput {
  providerId: string
  backend: CredentialBackend
  externalRef: string
  status: CredentialStatus
  actor: string
}

export interface CreateModelRouteInput {
  key: string
  name: string
  providerModelId: string
  enabled: boolean
  actor: string
}

export interface UpdateModelRouteInput {
  routeId: string
  name: string
  providerModelId: string
  enabled: boolean
  actor: string
}
