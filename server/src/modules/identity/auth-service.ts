import type { IncomingMessage } from 'node:http'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { AiHubApiError, AiHubClient } from './ai-hub-client.ts'
import { OidcProtocolError, OidcProviderClient } from './oidc-client.ts'
import { equalOpaqueHash, hashOpaque, randomOpaque, SecretBox } from './secure-values.ts'
import {
  IdentitySessionRepository,
  mappedRoleIds,
  type AuthenticationSessionRecord,
} from './session-repository.ts'
import type {
  ApiAudience,
  OidcAudienceConfiguration,
  OidcIdentityConfiguration,
  PlatformDataScope,
  PlatformPermissionSnapshot,
  RequestIdentity,
  VerifiedToken,
} from './types.ts'
import { AI_HUB_PERMISSIONS } from './types.ts'

export class IdentityAccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'IdentityAccessError'
    this.status = status
    this.code = code
  }
}

export class OidcAuthService {
  private readonly configuration: OidcIdentityConfiguration
  private readonly repository: IdentitySessionRepository
  private readonly secretBox: SecretBox
  private readonly platform: AiHubClient
  private readonly providers: Record<ApiAudience, OidcProviderClient>

  constructor(configuration: OidcIdentityConfiguration, database: DatabaseClient) {
    this.configuration = configuration
    this.repository = new IdentitySessionRepository(database)
    this.secretBox = new SecretBox(configuration.sessionSecret)
    this.platform = new AiHubClient(configuration.platformUrl)
    this.providers = {
      workbench: provider(configuration, 'workbench'),
      admin: provider(configuration, 'admin'),
    }
  }

  async beginLogin(audience: ApiAudience, requestedReturnTo: string | null) {
    const settings = this.configuration.audiences[audience]
    const authorization = await this.providers[audience].createAuthorizationRequest(
      settings.redirectUri,
      settings.loginScopes,
    )
    const transactionToken = randomOpaque()
    await this.repository.createLoginTransaction({
      transactionHash: hashOpaque(transactionToken),
      audience,
      stateHash: hashOpaque(authorization.state),
      codeVerifierEncrypted: this.secretBox.seal(authorization.codeVerifier),
      nonce: authorization.nonce,
      returnTo: normalizeReturnTo(requestedReturnTo, settings.portalUrl),
      expiresAt: new Date(Date.now() + this.configuration.transactionTtlSeconds * 1000),
    })
    return {
      location: authorization.url,
      cookie: serializeCookie(
        settings.transactionCookieName,
        transactionToken,
        this.configuration.transactionTtlSeconds,
        this.configuration.cookieSecure,
      ),
    }
  }

  async completeLogin(input: {
    audience: ApiAudience
    code: string
    state: string
    transactionToken: string
  }) {
    const settings = this.configuration.audiences[input.audience]
    const transaction = await this.repository.consumeLoginTransaction(
      hashOpaque(input.transactionToken),
      input.audience,
    )
    if (!transaction || !equalOpaqueHash(input.state, transaction.stateHash)) {
      throw new IdentityAccessError(401, 'invalid_state', 'OIDC 登录状态无效或已过期')
    }

    let tokenResponse
    let verified: VerifiedToken
    try {
      tokenResponse = await this.providers[input.audience].exchangeCode(
        input.code,
        settings.redirectUri,
        this.secretBox.open(transaction.codeVerifierEncrypted),
      )
      verified = await this.providers[input.audience].verify(tokenResponse.accessToken, {
        requiredScopes: ['ai_hub.identity', 'platform.me.read'],
        requireAiHubUser: true,
      })
      if (!tokenResponse.idToken) throw new OidcProtocolError('missing_id_token', 'OIDC 响应缺少 ID Token')
      const idToken = await this.providers[input.audience].verify(tokenResponse.idToken, {
        expectedNonce: transaction.nonce,
        expectedAudience: settings.clientId,
      })
      if (idToken.subject !== verified.subject) {
        throw new OidcProtocolError('invalid_subject', 'OIDC Token subject 不一致')
      }
    } catch (error) {
      throw identityError(error)
    }

    const { user, snapshot, dataScopes } = await this.loadPlatformIdentity(
      tokenResponse.accessToken,
      settings,
      verified,
    )
    const userId = await this.repository.synchronizeUser({
      audience: input.audience,
      applicationId: settings.applicationId,
      user,
      snapshot,
      dataScopes,
    })
    assertAudienceAccess(input.audience, snapshot.permissions, false)

    const sessionToken = randomOpaque()
    const now = Date.now()
    const tokenExpiresAt = new Date(verified.expiresAt * 1000)
    const configuredSessionExpiry = new Date(now + this.configuration.sessionTtlSeconds * 1000)
    const expiresAt = tokenResponse.refreshToken
      ? configuredSessionExpiry
      : new Date(Math.min(configuredSessionExpiry.getTime(), tokenExpiresAt.getTime()))
    await this.repository.createSession({
      sessionHash: hashOpaque(sessionToken),
      audience: input.audience,
      userId,
      accessTokenEncrypted: this.secretBox.seal(tokenResponse.accessToken),
      refreshTokenEncrypted: tokenResponse.refreshToken
        ? this.secretBox.seal(tokenResponse.refreshToken)
        : null,
      tokenExpiresAt,
      authorizationVersion: snapshot.authorization_version,
      permissions: snapshot.permissions,
      dataScopes,
      permissionsExpiresAt: validFutureDate(snapshot.expires_at, 'AI Hub 权限快照'),
      expiresAt,
    })
    await this.repository.appendAudit({
      userId,
      action: 'identity.login',
      result: 'success',
      audience: input.audience,
    })
    return {
      location: transaction.returnTo,
      sessionCookie: serializeCookie(
        settings.sessionCookieName,
        sessionToken,
        Math.max(1, Math.floor((expiresAt.getTime() - now) / 1000)),
        this.configuration.cookieSecure,
      ),
      clearTransactionCookie: clearCookie(
        settings.transactionCookieName,
        this.configuration.cookieSecure,
      ),
    }
  }

  async authenticateApi(request: IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
    const settings = this.configuration.audiences[audience]
    const cookieValue = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (!cookieValue) throw new IdentityAccessError(401, 'authentication_required', '请先登录')
    let session = await this.repository.findSession(hashOpaque(cookieValue), audience)
    if (!session) throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')

    validateRequestOrigin(request, settings.portalUrl)
    session = await this.refreshSession(session, settings)
    assertAudienceAccess(audience, session.permissions, isUnsafeMethod(request.method))

    const accessToken = this.secretBox.open(session.accessTokenEncrypted)
    if (
      audience === 'admin'
      && isUnsafeMethod(request.method)
      && this.configuration.adminOnlineAuthorization
    ) {
      try {
        const allowed = await this.platform.authorize(
          accessToken,
          settings.applicationId,
          AI_HUB_PERMISSIONS.adminWrite,
        )
        if (!allowed) throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理写权限')
      } catch (error) {
        if (error instanceof IdentityAccessError) throw error
        throw identityError(error)
      }
    }

    const roleIds = mappedRoleIds(audience, session.permissions)
    const profile = await this.repository.profile({
      userId: session.userId,
      audience,
      applicationId: settings.applicationId,
      permissions: session.permissions,
      sessionDataScopes: session.dataScopes,
    })
    await this.repository.touch(session.sessionHash)
    return {
      audience,
      applicationId: settings.applicationId,
      sessionHash: session.sessionHash,
      userId: session.userId,
      subject: session.subject,
      profile,
      roleIds,
      permissions: [...session.permissions],
      dataScopes: [...profile.dataScopes],
      authorizationVersion: session.authorizationVersion,
      identityProvider: 'ai-hub-oidc',
    }
  }

  async logout(request: IncomingMessage, audience: ApiAudience) {
    const settings = this.configuration.audiences[audience]
    const cookieValue = parseCookies(request.headers.cookie)[settings.sessionCookieName]
    if (cookieValue) {
      const sessionHash = hashOpaque(cookieValue)
      const session = await this.repository.findSession(sessionHash, audience)
      await this.repository.revoke(sessionHash)
      if (session) {
        await this.repository.appendAudit({
          userId: session.userId,
          action: 'identity.logout',
          result: 'success',
          audience,
        })
      }
    }
    return {
      location: await this.providers[audience].logoutUrl(settings.portalUrl),
      clearSessionCookie: clearCookie(settings.sessionCookieName, this.configuration.cookieSecure),
    }
  }

  transactionCookie(request: IncomingMessage, audience: ApiAudience) {
    const name = this.configuration.audiences[audience].transactionCookieName
    return parseCookies(request.headers.cookie)[name] ?? null
  }

  errorRedirect(audience: ApiAudience, code: string) {
    const url = new URL('/auth/error', `${this.configuration.audiences[audience].portalUrl}/`)
    url.searchParams.set('code', safeErrorCode(code))
    return url.toString()
  }

  clearTransactionCookie(audience: ApiAudience) {
    return clearCookie(
      this.configuration.audiences[audience].transactionCookieName,
      this.configuration.cookieSecure,
    )
  }

  private async refreshSession(
    original: AuthenticationSessionRecord,
    settings: OidcAudienceConfiguration,
  ) {
    let session = original
    let accessToken = this.secretBox.open(session.accessTokenEncrypted)
    if (session.tokenExpiresAt.getTime() <= Date.now() + 30_000) {
      try {
        const refreshed = await this.repository.refreshTokensWithLock(
          session.sessionHash,
          session.audience,
          async (latest) => {
            if (latest.tokenExpiresAt.getTime() > Date.now() + 30_000) return null
            if (!latest.refreshTokenEncrypted) {
              throw new IdentityAccessError(401, 'session_expired', '登录凭据已经过期')
            }
            const tokenResponse = await this.providers[latest.audience].refresh(
              this.secretBox.open(latest.refreshTokenEncrypted),
            )
            const verified = await this.providers[latest.audience].verify(tokenResponse.accessToken, {
              requiredScopes: ['ai_hub.identity', 'platform.me.read'],
              requireAiHubUser: true,
            })
            if (verified.subject !== latest.subject) {
              throw new OidcProtocolError('invalid_subject', '刷新后的用户身份不一致')
            }
            return {
              accessTokenEncrypted: this.secretBox.seal(tokenResponse.accessToken),
              refreshTokenEncrypted: tokenResponse.refreshToken
                ? this.secretBox.seal(tokenResponse.refreshToken)
                : latest.refreshTokenEncrypted,
              tokenExpiresAt: new Date(verified.expiresAt * 1000),
              forceAuthorizationRefresh: verified.authorizationVersion !== latest.authorizationVersion,
            }
          },
        )
        if (!refreshed) {
          throw new IdentityAccessError(401, 'session_expired', '登录会话不存在或已过期')
        }
        session = refreshed
        accessToken = this.secretBox.open(session.accessTokenEncrypted)
      } catch (error) {
        if (shouldRevokeAfterRefreshFailure(error)) {
          await this.repository.revoke(session.sessionHash)
        }
        throw identityError(error, error instanceof OidcProtocolError ? 401 : 503)
      }
    }

    if (session.permissionsExpiresAt.getTime() <= Date.now()) {
      let verified: VerifiedToken
      try {
        verified = await this.providers[session.audience].verify(accessToken, {
          requiredScopes: ['ai_hub.identity', 'platform.me.read'],
          requireAiHubUser: true,
        })
      } catch (error) {
        await this.repository.revoke(session.sessionHash)
        throw identityError(error, 401)
      }
      const { user, snapshot, dataScopes } = await this.loadPlatformIdentity(
        accessToken,
        settings,
        verified,
      )
      const userId = await this.repository.synchronizeUser({
        audience: session.audience,
        applicationId: settings.applicationId,
        user,
        snapshot,
        dataScopes,
      })
      if (userId !== session.userId) {
        await this.repository.revoke(session.sessionHash)
        throw new IdentityAccessError(401, 'identity_changed', '登录身份发生变化，请重新登录')
      }
      const permissionsExpiresAt = validFutureDate(snapshot.expires_at, 'AI Hub 权限快照')
      await this.repository.updateAuthorization({
        sessionHash: session.sessionHash,
        authorizationVersion: snapshot.authorization_version,
        permissions: snapshot.permissions,
        dataScopes,
        permissionsExpiresAt,
      })
      session = {
        ...session,
        authorizationVersion: snapshot.authorization_version,
        permissions: snapshot.permissions,
        dataScopes,
        permissionsExpiresAt,
      }
    }
    return session
  }

  private async loadPlatformIdentity(
    accessToken: string,
    settings: OidcAudienceConfiguration,
    verified: VerifiedToken,
  ) {
    try {
      const [user, snapshot] = await Promise.all([
        this.platform.me(accessToken, settings.applicationId),
        this.platform.permissions(accessToken, settings.applicationId),
      ])
      if (user.status.toUpperCase() !== 'ACTIVE') {
        throw new IdentityAccessError(403, 'account_disabled', 'AI Hub 用户已停用')
      }
      if (user.subject !== verified.subject || snapshot.user_id !== user.user_id) {
        throw new IdentityAccessError(401, 'identity_mismatch', 'AI Hub 用户身份映射不一致')
      }
      if (snapshot.application_id !== settings.applicationId) {
        throw new IdentityAccessError(403, 'application_mismatch', 'AI Hub 权限快照不属于当前应用')
      }
      if (
        verified.authorizationVersion !== user.authorization_version
        || snapshot.authorization_version !== user.authorization_version
      ) {
        throw new IdentityAccessError(401, 'authorization_version_mismatch', 'AI Hub 授权版本已变化，请重新登录')
      }
      return { user, snapshot, dataScopes: normalizeDataScopes(snapshot.data_scopes) }
    } catch (error) {
      if (error instanceof IdentityAccessError) throw error
      throw identityError(error)
    }
  }
}

function provider(configuration: OidcIdentityConfiguration, audience: ApiAudience) {
  const settings = configuration.audiences[audience]
  return new OidcProviderClient({
    issuer: settings.issuer,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    expectedAudience: settings.tokenAudience,
    cacheTtlSeconds: configuration.jwksCacheTtlSeconds,
    staleTtlSeconds: configuration.jwksStaleTtlSeconds,
  })
}

function assertAudienceAccess(audience: ApiAudience, permissions: string[], unsafe: boolean) {
  const granted = new Set(permissions)
  if (audience === 'workbench') {
    if (!granted.has(AI_HUB_PERMISSIONS.workbenchUse) && !granted.has(AI_HUB_PERMISSIONS.workbenchManage)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有员工工作台访问权限')
    }
    return
  }
  if (unsafe) {
    if (!granted.has(AI_HUB_PERMISSIONS.adminWrite)) {
      throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理写权限')
    }
    return
  }
  if (
    !granted.has(AI_HUB_PERMISSIONS.adminWrite)
    && !granted.has(AI_HUB_PERMISSIONS.adminRead)
    && !granted.has(AI_HUB_PERMISSIONS.auditRead)
  ) {
    throw new IdentityAccessError(403, 'permission_denied', '当前用户没有管理后台访问权限')
  }
}

function normalizeDataScopes(scopes: PlatformDataScope[]) {
  return [...new Set(scopes.map((scope) => {
    const direct = scope.value.code ?? scope.value.scope ?? scope.value.value
    if (typeof direct === 'string' && direct.trim()) {
      return direct.includes(':') ? direct : `${scope.scope_type}:${direct}`
    }
    const entries = Object.entries(scope.value)
    if (entries.length === 1 && typeof entries[0]?.[1] === 'string') {
      return `${scope.scope_type}:${entries[0][1]}`
    }
    return `${scope.scope_type}:${stableJson(scope.value)}`
  }))].sort()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeReturnTo(value: string | null, portalUrl: string) {
  const portal = new URL(`${portalUrl.replace(/\/$/, '')}/`)
  if (!value) return portal.toString()
  try {
    const candidate = new URL(value, portal)
    if (candidate.origin !== portal.origin) return portal.toString()
    return candidate.toString()
  } catch {
    return portal.toString()
  }
}

function validFutureDate(value: string, label: string) {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    throw new IdentityAccessError(401, 'invalid_authorization_snapshot', `${label}已经过期或格式无效`)
  }
  return parsed
}

function validateRequestOrigin(request: IncomingMessage, portalUrl: string) {
  if (!isUnsafeMethod(request.method)) return
  const origin = request.headers.origin
  if (!origin || origin !== new URL(portalUrl).origin) {
    throw new IdentityAccessError(403, 'csrf_check_failed', '请求来源校验失败')
  }
}

function isUnsafeMethod(method: string | undefined) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method ?? 'GET')
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {}
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (!name || !value) continue
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      continue
    }
  }
  return cookies
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function clearCookie(name: string, secure: boolean) {
  return serializeCookie(name, '', 0, secure)
}

function safeErrorCode(code: string) {
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code : 'authentication_failed'
}

function identityError(error: unknown, defaultStatus = 502) {
  if (error instanceof IdentityAccessError) return error
  if (error instanceof AiHubApiError) {
    if (error.status === 401) return new IdentityAccessError(401, error.code, error.message)
    if (error.status === 403) return new IdentityAccessError(403, error.code, error.message)
    return new IdentityAccessError(503, error.code, error.message)
  }
  if (error instanceof OidcProtocolError) {
    const status = ['identity_provider_unavailable'].includes(error.code) ? 503 : defaultStatus
    return new IdentityAccessError(status, error.code, error.message)
  }
  return new IdentityAccessError(defaultStatus, 'authentication_failed', '身份认证未完成')
}

function shouldRevokeAfterRefreshFailure(error: unknown) {
  if (error instanceof IdentityAccessError) return error.status === 401
  if (!(error instanceof OidcProtocolError)) return false
  return ![
    'identity_provider_unavailable',
    'invalid_oidc_metadata',
    'invalid_jwks',
    'unknown_signing_key',
  ].includes(error.code)
}

export function permissionSnapshotForTest(input: Partial<PlatformPermissionSnapshot> = {}): PlatformPermissionSnapshot {
  return {
    application_id: 'dsh-work',
    user_id: 'user-test',
    permissions: [AI_HUB_PERMISSIONS.workbenchUse],
    data_scopes: [],
    authorization_version: 1,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...input,
  }
}
