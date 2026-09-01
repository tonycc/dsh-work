import { randomUUID } from 'node:crypto'

import type { UserProfile, UserRole } from '../../domain/types.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { hashOpaque } from './secure-values.ts'
import type {
  ApiAudience,
  CurrentPlatformUser,
  PlatformPermissionSnapshot,
} from './types.ts'
import { AI_HUB_PERMISSIONS } from './types.ts'

const tenantId = 'tenant-dsh-work'

export interface LoginTransactionRecord {
  stateHash: string
  codeVerifierEncrypted: string
  nonce: string
  returnTo: string
}

export interface AuthenticationSessionRecord {
  sessionHash: string
  audience: ApiAudience
  userId: string
  subject: string
  accessTokenEncrypted: string
  refreshTokenEncrypted: string | null
  tokenExpiresAt: Date
  authorizationVersion: number
  permissions: string[]
  dataScopes: string[]
  permissionsExpiresAt: Date
  expiresAt: Date
}

export class IdentitySessionRepository {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async createLoginTransaction(input: {
    transactionHash: string
    audience: ApiAudience
    stateHash: string
    codeVerifierEncrypted: string
    nonce: string
    returnTo: string
    expiresAt: Date
  }) {
    await this.database.begin(async (transaction) => {
      await transaction`delete from oidc_login_transactions where expires_at <= now()`
      await transaction`
        insert into oidc_login_transactions (
          transaction_hash, audience, state_hash, code_verifier_encrypted,
          nonce, return_to, expires_at
        ) values (
          ${input.transactionHash}, ${input.audience}, ${input.stateHash},
          ${input.codeVerifierEncrypted}, ${input.nonce}, ${input.returnTo}, ${input.expiresAt}
        )
      `
    })
  }

  async consumeLoginTransaction(
    transactionHash: string,
    audience: ApiAudience,
  ): Promise<LoginTransactionRecord | null> {
    return this.database.begin(async (transaction) => {
      const [record] = await transaction<LoginTransactionRecord[]>`
        delete from oidc_login_transactions
         where transaction_hash = ${transactionHash} and audience = ${audience}
           and expires_at > now()
        returning state_hash as "stateHash", code_verifier_encrypted as "codeVerifierEncrypted",
                  nonce, return_to as "returnTo"
      `
      return record ?? null
    })
  }

  async synchronizeUser(input: {
    audience: ApiAudience
    applicationId: string
    user: CurrentPlatformUser
    snapshot: PlatformPermissionSnapshot
    dataScopes: string[]
  }) {
    return this.database.begin(async (transaction) => {
      const [user] = await transaction<{ id: string }[]>`
        insert into users (
          id, tenant_id, external_subject, display_name, department_id, status
        ) values (
          ${input.user.user_id}, ${tenantId}, ${input.user.subject},
          ${input.user.display_name}, ${input.user.organization_name}, 'active'
        )
        on conflict (tenant_id, external_subject) do update
          set display_name = excluded.display_name,
              department_id = excluded.department_id,
              status = excluded.status,
              updated_at = now()
        returning id
      `
      if (!user) throw new Error('AI Hub 用户同步失败')

      const managedRoleIds = input.audience === 'workbench'
        ? ['role-employee', 'role-department-manager']
        : ['role-platform-admin', 'role-auditor']
      const sourceKey = aiHubRoleSourceKey(input.audience, input.applicationId)
      await transaction`
        delete from user_roles
         where tenant_id = ${tenantId} and user_id = ${user.id}
           and role_id in ${transaction(managedRoleIds)}
           and source_key like ${`ai-hub:${input.audience}:%`}
      `
      for (const roleId of mappedRoleIds(input.audience, input.snapshot.permissions)) {
        await transaction`
          insert into user_roles (tenant_id, user_id, role_id, source_key)
          values (${tenantId}, ${user.id}, ${roleId}, ${sourceKey})
          on conflict do nothing
        `
      }

      const scopeCode = `ai-hub:${input.applicationId}`
      await transaction`
        delete from data_scope_grants
         where tenant_id = ${tenantId} and subject_type = 'user'
           and subject_id = ${user.id} and scope_code = ${scopeCode}
      `
      for (const scopeValue of [...new Set(input.dataScopes)].sort()) {
        const grantId = `grant-aihub-${hashOpaque(`${input.applicationId}:${user.id}:${scopeValue}`).slice(0, 32)}`
        await transaction`
          insert into data_scope_grants (
            id, tenant_id, subject_type, subject_id, scope_code, scope_value
          ) values (
            ${grantId}, ${tenantId}, 'user', ${user.id}, ${scopeCode}, ${scopeValue}
          )
          on conflict do nothing
        `
      }
      return user.id
    })
  }

  async createSession(input: {
    sessionHash: string
    audience: ApiAudience
    userId: string
    accessTokenEncrypted: string
    refreshTokenEncrypted: string | null
    tokenExpiresAt: Date
    authorizationVersion: number
    permissions: string[]
    dataScopes: string[]
    permissionsExpiresAt: Date
    expiresAt: Date
  }) {
    await this.database.begin(async (transaction) => {
      await transaction`
        update authentication_sessions set revoked_at = now()
         where tenant_id = ${tenantId} and user_id = ${input.userId}
           and audience = ${input.audience} and revoked_at is null
      `
      await transaction`
        insert into authentication_sessions (
          session_hash, tenant_id, audience, user_id, access_token_encrypted,
          refresh_token_encrypted, token_expires_at, authorization_version,
          permissions, data_scopes, permissions_expires_at, expires_at
        ) values (
          ${input.sessionHash}, ${tenantId}, ${input.audience}, ${input.userId},
          ${input.accessTokenEncrypted}, ${input.refreshTokenEncrypted}, ${input.tokenExpiresAt},
          ${input.authorizationVersion}, ${transaction.json(input.permissions)},
          ${transaction.json(input.dataScopes)}, ${input.permissionsExpiresAt}, ${input.expiresAt}
        )
      `
    })
  }

  async findSession(sessionHash: string, audience: ApiAudience): Promise<AuthenticationSessionRecord | null> {
    const [record] = await this.database<AuthenticationSessionRecord[]>`
      select s.session_hash as "sessionHash", s.audience, s.user_id as "userId",
             u.external_subject as subject,
             access_token_encrypted as "accessTokenEncrypted",
             refresh_token_encrypted as "refreshTokenEncrypted",
             token_expires_at as "tokenExpiresAt", authorization_version as "authorizationVersion",
             permissions, data_scopes as "dataScopes",
             permissions_expires_at as "permissionsExpiresAt", expires_at as "expiresAt"
        from authentication_sessions s
        join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
       where s.session_hash = ${sessionHash} and s.tenant_id = ${tenantId}
         and s.audience = ${audience} and s.revoked_at is null and s.expires_at > now()
    `
    return record ?? null
  }

  async refreshTokensWithLock(
    sessionHash: string,
    audience: ApiAudience,
    refresh: (session: AuthenticationSessionRecord) => Promise<{
      accessTokenEncrypted: string
      refreshTokenEncrypted: string | null
      tokenExpiresAt: Date
      forceAuthorizationRefresh: boolean
    } | null>,
  ): Promise<AuthenticationSessionRecord | null> {
    return this.database.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${sessionHash}`}))`
      const [session] = await transaction<AuthenticationSessionRecord[]>`
        select s.session_hash as "sessionHash", s.audience, s.user_id as "userId",
               u.external_subject as subject,
               access_token_encrypted as "accessTokenEncrypted",
               refresh_token_encrypted as "refreshTokenEncrypted",
               token_expires_at as "tokenExpiresAt", authorization_version as "authorizationVersion",
               permissions, data_scopes as "dataScopes",
               permissions_expires_at as "permissionsExpiresAt", expires_at as "expiresAt"
          from authentication_sessions s
          join users u on u.tenant_id = s.tenant_id and u.id = s.user_id
         where s.session_hash = ${sessionHash} and s.tenant_id = ${tenantId}
           and s.audience = ${audience} and s.revoked_at is null and s.expires_at > now()
      `
      if (!session) return null
      const update = await refresh(session)
      if (!update) return session
      await transaction`
        update authentication_sessions
           set access_token_encrypted = ${update.accessTokenEncrypted},
               refresh_token_encrypted = ${update.refreshTokenEncrypted},
               token_expires_at = ${update.tokenExpiresAt},
               permissions_expires_at = case
                 when ${update.forceAuthorizationRefresh} then to_timestamp(0)
                 else permissions_expires_at
               end,
               last_seen_at = now()
         where session_hash = ${sessionHash} and tenant_id = ${tenantId}
           and revoked_at is null and expires_at > now()
      `
      return {
        ...session,
        ...update,
        permissionsExpiresAt: update.forceAuthorizationRefresh
          ? new Date(0)
          : session.permissionsExpiresAt,
      }
    })
  }

  async updateTokens(input: {
    sessionHash: string
    accessTokenEncrypted: string
    refreshTokenEncrypted: string | null
    tokenExpiresAt: Date
  }) {
    await this.database`
      update authentication_sessions
         set access_token_encrypted = ${input.accessTokenEncrypted},
             refresh_token_encrypted = ${input.refreshTokenEncrypted},
             token_expires_at = ${input.tokenExpiresAt}, last_seen_at = now()
       where session_hash = ${input.sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async updateAuthorization(input: {
    sessionHash: string
    authorizationVersion: number
    permissions: string[]
    dataScopes: string[]
    permissionsExpiresAt: Date
  }) {
    await this.database`
      update authentication_sessions
         set authorization_version = ${input.authorizationVersion},
             permissions = ${this.database.json(input.permissions)},
             data_scopes = ${this.database.json(input.dataScopes)},
             permissions_expires_at = ${input.permissionsExpiresAt},
             last_seen_at = now()
       where session_hash = ${input.sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async touch(sessionHash: string) {
    await this.database`
      update authentication_sessions set last_seen_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId}
         and revoked_at is null and expires_at > now()
    `
  }

  async revoke(sessionHash: string) {
    await this.database`
      update authentication_sessions set revoked_at = now()
       where session_hash = ${sessionHash} and tenant_id = ${tenantId} and revoked_at is null
    `
  }

  async profile(input: {
    userId: string
    audience: ApiAudience
    applicationId: string
    permissions: string[]
    sessionDataScopes: string[]
  }): Promise<UserProfile> {
    const roleSourceKey = aiHubRoleSourceKey(input.audience, input.applicationId)
    const scopeCode = `ai-hub:${input.applicationId}`
    const [user] = await this.database<{
      id: string
      name: string
      department: string
      roleCodes: string[]
      localDataScopes: string[]
    }[]>`
      select u.id, u.display_name as name,
             coalesce(u.department_id, '未分配部门') as department,
             coalesce(array_agg(distinct r.code) filter (where r.code is not null), '{}') as "roleCodes",
             coalesce(array_agg(distinct dsg.scope_value) filter (where dsg.scope_value is not null), '{}') as "localDataScopes"
        from users u
        left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
          and (ur.valid_until is null or ur.valid_until > now())
          and ur.source_key = ${roleSourceKey}
        left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
        left join data_scope_grants dsg on dsg.tenant_id = u.tenant_id
          and (
            (dsg.subject_type = 'user' and dsg.subject_id = u.id and dsg.scope_code = ${scopeCode})
            or (dsg.subject_type = 'role' and dsg.subject_id = r.id)
          )
       where u.tenant_id = ${tenantId} and u.id = ${input.userId} and u.status = 'active'
       group by u.id
    `
    if (!user) throw new Error('当前用户不存在、已停用或所属企业不可用')
    const role = primaryRole(user.roleCodes, input.permissions)
    return {
      id: user.id,
      name: user.name,
      title: roleTitle(role),
      department: user.department,
      avatarText: [...user.name][0] ?? '用',
      role,
      dataScopes: [...new Set([...user.localDataScopes, ...input.sessionDataScopes])].sort(),
    }
  }

  async appendAudit(input: {
    userId: string
    action: 'identity.login' | 'identity.logout'
    result: 'success' | 'failed' | 'blocked'
    audience: ApiAudience
  }) {
    await this.database`
      insert into audit_events (
        id, tenant_id, actor_type, actor_id, action, object_type,
        object_id, result, trace_id, safe_context
      ) values (
        ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${input.userId}, ${input.action},
        'identity_session', ${input.audience}, ${input.result},
        ${`trace-identity-${randomUUID()}`},
        ${this.database.json({ audience: input.audience, provider: 'ai-hub-oidc' })}
      )
    `
  }
}

export function mappedRoleIds(audience: ApiAudience, permissions: string[]) {
  const granted = new Set(permissions)
  if (audience === 'workbench') {
    if (granted.has(AI_HUB_PERMISSIONS.workbenchManage)) {
      return ['role-employee', 'role-department-manager']
    }
    if (granted.has(AI_HUB_PERMISSIONS.workbenchUse)) return ['role-employee']
    return []
  }
  if (granted.has(AI_HUB_PERMISSIONS.adminWrite)) return ['role-platform-admin']
  if (granted.has(AI_HUB_PERMISSIONS.adminRead) || granted.has(AI_HUB_PERMISSIONS.auditRead)) return ['role-auditor']
  return []
}

export function aiHubRoleSourceKey(audience: ApiAudience, applicationId: string) {
  return `ai-hub:${audience}:${applicationId}`
}

function primaryRole(roleCodes: string[], permissions: string[]): UserRole {
  const roles = new Set(roleCodes)
  const granted = new Set(permissions)
  if (roles.has('platform_admin') || granted.has(AI_HUB_PERMISSIONS.adminWrite)) return 'platform_admin'
  if (roles.has('auditor') || granted.has(AI_HUB_PERMISSIONS.auditRead)) return 'auditor'
  if (roles.has('department_manager') || granted.has(AI_HUB_PERMISSIONS.workbenchManage)) return 'department_manager'
  return 'employee'
}

function roleTitle(role: UserRole) {
  if (role === 'platform_admin') return 'AI 平台管理员'
  if (role === 'auditor') return '安全审计员'
  if (role === 'department_manager') return '部门负责人'
  return '企业员工'
}
