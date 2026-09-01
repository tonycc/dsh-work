import type {
  ApiAudience,
  IdentityConfiguration,
  OidcAudienceConfiguration,
  OidcIdentityConfiguration,
} from './types.ts'

const defaultScopes = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'ai_hub.identity',
  'platform.me.read',
]

export function loadIdentityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityConfiguration {
  const production = environment.NODE_ENV === 'production'
  const mode = environment.DSH_WORK_AUTH_MODE ?? (production ? 'oidc' : 'prototype')
  if (mode !== 'prototype' && mode !== 'oidc') {
    throw new Error('DSH_WORK_AUTH_MODE 必须是 prototype 或 oidc')
  }
  if (production && mode !== 'oidc') {
    throw new Error('生产环境必须显式启用 AI Hub OIDC，禁止回退到 Prototype 身份')
  }
  if (mode === 'prototype') return { mode }

  const sessionSecret = required(environment, 'DSH_WORK_SESSION_SECRET')
  if (sessionSecret.length < 32) throw new Error('DSH_WORK_SESSION_SECRET 至少需要 32 个字符')
  if (production && placeholderSecret(sessionSecret)) {
    throw new Error('生产环境的 DSH_WORK_SESSION_SECRET 不能使用占位值')
  }

  const cookieSecure = booleanValue(
    environment.DSH_WORK_COOKIE_SECURE,
    production,
    'DSH_WORK_COOKIE_SECURE',
  )
  if (production && !cookieSecure) throw new Error('生产环境必须启用 Secure Session Cookie')

  const platformUrl = normalizedUrl(
    required(environment, 'AI_HUB_PLATFORM_URL'),
    'AI_HUB_PLATFORM_URL',
    production,
  )
  const workbench = audienceConfiguration(environment, 'workbench', production)
  const admin = audienceConfiguration(environment, 'admin', production)
  const jwksCacheTtlSeconds = positiveInteger(
    environment.DSH_WORK_OIDC_JWKS_CACHE_TTL_SECONDS,
    300,
    'DSH_WORK_OIDC_JWKS_CACHE_TTL_SECONDS',
  )
  const jwksStaleTtlSeconds = positiveInteger(
    environment.DSH_WORK_OIDC_JWKS_STALE_TTL_SECONDS,
    3600,
    'DSH_WORK_OIDC_JWKS_STALE_TTL_SECONDS',
  )
  if (jwksStaleTtlSeconds < jwksCacheTtlSeconds) {
    throw new Error('OIDC JWKS 陈旧窗口不能短于正常缓存时间')
  }
  const adminOnlineAuthorization = booleanValue(
    environment.DSH_WORK_ADMIN_ONLINE_AUTHORIZATION,
    true,
    'DSH_WORK_ADMIN_ONLINE_AUTHORIZATION',
  )
  if (production && !adminOnlineAuthorization) {
    throw new Error('生产环境必须启用管理写操作在线授权校验')
  }

  return {
    mode,
    platformUrl,
    sessionSecret,
    sessionTtlSeconds: positiveInteger(
      environment.DSH_WORK_SESSION_TTL_SECONDS,
      8 * 60 * 60,
      'DSH_WORK_SESSION_TTL_SECONDS',
    ),
    transactionTtlSeconds: positiveInteger(
      environment.DSH_WORK_OIDC_TRANSACTION_TTL_SECONDS,
      10 * 60,
      'DSH_WORK_OIDC_TRANSACTION_TTL_SECONDS',
    ),
    cookieSecure,
    adminOnlineAuthorization,
    jwksCacheTtlSeconds,
    jwksStaleTtlSeconds,
    audiences: { workbench, admin },
  } satisfies OidcIdentityConfiguration
}

function audienceConfiguration(
  environment: NodeJS.ProcessEnv,
  audience: ApiAudience,
  production: boolean,
): OidcAudienceConfiguration {
  const prefix = audience === 'workbench' ? 'AI_HUB_WORKBENCH' : 'AI_HUB_ADMIN'
  const applicationId = audienceOrShared(environment, prefix, 'APPLICATION_ID')
  const clientId = audienceOrShared(environment, prefix, 'CLIENT_ID')
  const issuerName = environment[`${prefix}_OIDC_ISSUER`]?.trim()
    ? `${prefix}_OIDC_ISSUER`
    : 'AI_HUB_OIDC_ISSUER'
  const issuer = normalizedIssuer(audienceOrShared(environment, prefix, 'OIDC_ISSUER'), issuerName, production)
  const redirectUri = normalizedUrl(required(environment, `${prefix}_REDIRECT_URI`), `${prefix}_REDIRECT_URI`, production)
  const portalUrl = normalizedUrl(required(environment, `${prefix}_PORTAL_URL`), `${prefix}_PORTAL_URL`, production)
  if (new URL(redirectUri).hash) throw new Error(`${prefix}_REDIRECT_URI 不能包含 URL Fragment`)
  const clientSecret = audienceOrShared(environment, prefix, 'CLIENT_SECRET')
  if (production && placeholderSecret(clientSecret)) {
    throw new Error(`生产环境的 ${prefix}_CLIENT_SECRET/AI_HUB_CLIENT_SECRET 不能使用占位值`)
  }

  return {
    audience,
    applicationId,
    issuer,
    tokenAudience: environment[`${prefix}_OIDC_AUDIENCE`]?.trim()
      || environment.AI_HUB_OIDC_AUDIENCE?.trim()
      || clientId,
    clientId,
    clientSecret,
    redirectUri,
    portalUrl,
    sessionCookieName: cookieName(
      audience === 'workbench' ? 'dsh_work_session' : 'dsh_work_admin_session',
      production,
    ),
    transactionCookieName: cookieName(
      audience === 'workbench' ? 'dsh_work_oidc_tx' : 'dsh_work_admin_oidc_tx',
      production,
    ),
    loginScopes: audience === 'admin'
      ? [...defaultScopes, 'platform.authorization.decide']
      : [...defaultScopes],
  }
}

function cookieName(name: string, production: boolean) {
  return production ? `__Host-${name}` : name
}

function audienceOrShared(
  environment: NodeJS.ProcessEnv,
  prefix: 'AI_HUB_WORKBENCH' | 'AI_HUB_ADMIN',
  suffix: 'APPLICATION_ID' | 'CLIENT_ID' | 'CLIENT_SECRET' | 'OIDC_ISSUER',
) {
  const audienceName = `${prefix}_${suffix}`
  const sharedName = `AI_HUB_${suffix}`
  const value = environment[audienceName]?.trim() || environment[sharedName]?.trim()
  if (!value) throw new Error(`${audienceName} 或 ${sharedName} 未配置`)
  return value
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} 未配置`)
  return value
}

function normalizedIssuer(value: string, name: string, production: boolean) {
  return `${normalizedUrl(value, name, production).replace(/\/$/, '')}/`
}

function normalizedUrl(value: string, name: string, production: boolean) {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} 不是有效 URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} 只允许 http 或 https`)
  if (parsed.username || parsed.password) throw new Error(`${name} 不能包含凭据`)
  if (production && parsed.protocol !== 'https:') throw new Error(`生产环境的 ${name} 必须使用 https`)
  return parsed.toString().replace(/\/$/, '')
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是正整数`)
  return parsed
}

function booleanValue(value: string | undefined, fallback: boolean, name: string) {
  if (value === undefined || value === '') return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} 必须是 true 或 false`)
}

function placeholderSecret(value: string) {
  const normalized = value.trim().toLowerCase()
  return ['change-me', 'replace-me', 'placeholder'].some((marker) =>
    normalized === marker || normalized.startsWith(`${marker}-`) || normalized.includes(`-${marker}`),
  ) || normalized === 'secret' || normalized.includes('local-only') || normalized.includes('example')
}
