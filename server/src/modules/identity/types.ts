import type { IncomingMessage } from 'node:http'

import type { UserProfile } from '../../domain/types.ts'

export type ApiAudience = 'workbench' | 'admin'
export type IdentityProvider = 'prototype-sso' | 'ai-hub-oidc'

export const AI_HUB_PERMISSIONS = {
  workbenchUse: 'dsh_work.workbench.use',
  workbenchManage: 'dsh_work.workbench.manage',
  adminRead: 'dsh_work.admin.read',
  adminWrite: 'dsh_work.admin.write',
  auditRead: 'dsh_work.audit.read',
} as const

export interface RequestIdentity {
  audience: ApiAudience
  applicationId: string
  sessionHash: string
  userId: string
  subject: string
  profile: UserProfile
  roleIds: string[]
  permissions: string[]
  dataScopes: string[]
  authorizationVersion: number
  identityProvider: IdentityProvider
}

export type ApiAuthenticator = (
  request: IncomingMessage,
  audience: ApiAudience,
) => Promise<RequestIdentity>

export interface OidcAudienceConfiguration {
  audience: ApiAudience
  applicationId: string
  issuer: string
  tokenAudience: string
  clientId: string
  clientSecret: string
  redirectUri: string
  portalUrl: string
  sessionCookieName: string
  transactionCookieName: string
  loginScopes: string[]
}

export interface PrototypeIdentityConfiguration {
  mode: 'prototype'
}

export interface OidcIdentityConfiguration {
  mode: 'oidc'
  platformUrl: string
  sessionSecret: string
  sessionTtlSeconds: number
  transactionTtlSeconds: number
  cookieSecure: boolean
  adminOnlineAuthorization: boolean
  jwksCacheTtlSeconds: number
  jwksStaleTtlSeconds: number
  audiences: Record<ApiAudience, OidcAudienceConfiguration>
}

export type IdentityConfiguration = PrototypeIdentityConfiguration | OidcIdentityConfiguration

export interface CurrentPlatformUser {
  user_id: string
  subject: string
  display_name: string
  email: string | null
  status: string
  organization_id: string
  organization_name: string
  authorization_version: number
}

export interface PlatformDataScope {
  scope_type: string
  value: Record<string, unknown>
}

export interface PlatformPermissionSnapshot {
  application_id: string
  user_id: string
  permissions: string[]
  data_scopes: PlatformDataScope[]
  authorization_version: number
  expires_at: string
}

export interface OAuthTokenResponse {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresIn: number
  scope: string
}

export interface VerifiedToken {
  subject: string
  issuer: string
  audiences: string[]
  expiresAt: number
  issuedAt: number
  scopes: string[]
  actorType: string | null
  authorizationVersion: number | null
  displayName: string | null
  email: string | null
  claims: Record<string, unknown>
}
