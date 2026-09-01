import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'

import { createDatabase, type DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { runMigrations } from '../../infrastructure/postgres/migration-runner.ts'
import { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { SecretBox, hashOpaque, randomOpaque } from './secure-values.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import { AI_HUB_PERMISSIONS } from './types.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const suffix = randomUUID()
const subject = `ai-hub-integration-${suffix}`
const userId = `ai-user-${suffix}`
const applicationId = 'dsh-work'
let database: DatabaseClient
let repository: IdentitySessionRepository

before(async () => {
  database = createDatabase({ url: databaseUrl, maxConnections: 4 })
  await runMigrations(database)
  repository = new IdentitySessionRepository(database)
})

after(async () => {
  if (!database) return
  await database`delete from authentication_sessions where tenant_id = 'tenant-dsh-work' and user_id = ${userId}`
  await database`delete from data_scope_grants where tenant_id = 'tenant-dsh-work' and subject_type = 'user' and subject_id = ${userId}`
  await database`delete from user_roles where tenant_id = 'tenant-dsh-work' and user_id = ${userId}`
  await database`update workspaces set workspace_type = 'team' where tenant_id = 'tenant-dsh-work' and created_by = ${userId} and workspace_type = 'personal'`
  await database`delete from workspace_members where tenant_id = 'tenant-dsh-work' and user_id = ${userId}`
  await database`delete from workspaces where tenant_id = 'tenant-dsh-work' and created_by = ${userId}`
  await database`delete from users where tenant_id = 'tenant-dsh-work' and id = ${userId}`
  await database.end()
})

test('M6 migration installs identity session tables, uploader attribution and role sources', async () => {
  const [record] = await database<{ count: number }[]>`
    select count(*)::integer as count
      from information_schema.columns
     where table_schema = 'public'
       and (
         (table_name = 'oidc_login_transactions' and column_name = 'transaction_hash')
         or (table_name = 'authentication_sessions' and column_name = 'session_hash')
         or (table_name = 'file_objects' and column_name = 'uploaded_by')
         or (table_name = 'user_roles' and column_name = 'source_key')
       )
  `
  assert.equal(record?.count, 4)
})

test('OIDC login transaction is short-lived and can only be consumed once', async () => {
  const transactionToken = randomOpaque()
  const transactionHash = hashOpaque(transactionToken)
  await repository.createLoginTransaction({
    transactionHash,
    audience: 'workbench',
    stateHash: hashOpaque('state-value'),
    codeVerifierEncrypted: 'encrypted-code-verifier',
    nonce: 'nonce-value',
    returnTo: 'http://localhost:4174/workbench',
    expiresAt: new Date(Date.now() + 60_000),
  })

  const consumed = await repository.consumeLoginTransaction(transactionHash, 'workbench')
  assert.equal(consumed?.nonce, 'nonce-value')
  assert.equal(await repository.consumeLoginTransaction(transactionHash, 'workbench'), null)
})

test('AI Hub user, roles, scopes and encrypted server session round-trip through PostgreSQL', async () => {
  const permissions = [AI_HUB_PERMISSIONS.workbenchUse, AI_HUB_PERMISSIONS.workbenchManage]
  const dataScopes = ['organization:org-integration', 'region:east']
  const synchronizedId = await repository.synchronizeUser({
    audience: 'workbench',
    applicationId,
    user: {
      user_id: userId,
      subject,
      display_name: 'SSO 集成用户',
      email: 'sso-integration@example.invalid',
      status: 'ACTIVE',
      organization_id: 'org-integration',
      organization_name: '集成测试组织',
      authorization_version: 3,
    },
    snapshot: {
      application_id: applicationId,
      user_id: userId,
      permissions,
      data_scopes: [],
      authorization_version: 3,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    dataScopes,
  })
  assert.equal(synchronizedId, userId)

  const sessionToken = randomOpaque()
  const secretBox = new SecretBox('integration-session-secret-with-at-least-32-characters')
  const accessTokenEncrypted = secretBox.seal('access-token-value')
  const refreshTokenEncrypted = secretBox.seal('refresh-token-value')
  const sessionHash = hashOpaque(sessionToken)
  await repository.createSession({
    sessionHash,
    audience: 'workbench',
    userId,
    accessTokenEncrypted,
    refreshTokenEncrypted,
    tokenExpiresAt: new Date(Date.now() + 300_000),
    authorizationVersion: 3,
    permissions,
    dataScopes,
    permissionsExpiresAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 600_000),
  })

  const stored = await repository.findSession(sessionHash, 'workbench')
  assert.equal(stored?.subject, subject)
  assert.equal(secretBox.open(stored?.accessTokenEncrypted ?? ''), 'access-token-value')
  assert.notEqual(stored?.accessTokenEncrypted, 'access-token-value')
  assert.deepEqual(stored?.permissions, permissions)
  assert.deepEqual(stored?.dataScopes, dataScopes)

  const profile = await repository.profile({
    userId,
    audience: 'workbench',
    applicationId,
    permissions,
    sessionDataScopes: dataScopes,
  })
  assert.equal(profile.role, 'department_manager')
  assert.equal(profile.department, '集成测试组织')
  assert.ok(profile.dataScopes.includes('region:east'))

  await repository.synchronizeUser({
    audience: 'admin',
    applicationId: 'dsh-work-admin',
    user: {
      user_id: userId,
      subject,
      display_name: 'SSO 集成用户',
      email: 'sso-integration@example.invalid',
      status: 'ACTIVE',
      organization_id: 'org-integration',
      organization_name: '集成测试组织',
      authorization_version: 4,
    },
    snapshot: {
      application_id: 'dsh-work-admin',
      user_id: userId,
      permissions: [AI_HUB_PERMISSIONS.adminWrite],
      data_scopes: [],
      authorization_version: 4,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    dataScopes: ['organization:admin-only'],
  })
  const workbenchAfterAdminLogin = await repository.profile({
    userId,
    audience: 'workbench',
    applicationId,
    permissions,
    sessionDataScopes: dataScopes,
  })
  assert.equal(workbenchAfterAdminLogin.role, 'department_manager')
  assert.equal(workbenchAfterAdminLogin.dataScopes.includes('organization:admin-only'), false)
  const roleRows = await database<{ roleId: string; sourceKey: string }[]>`
    select role_id as "roleId", source_key as "sourceKey" from user_roles
     where tenant_id = 'tenant-dsh-work' and user_id = ${userId}
     order by source_key, role_id
  `
  assert.ok(roleRows.some(row => row.roleId === 'role-employee'))
  assert.ok(roleRows.some(row => row.roleId === 'role-department-manager'))
  assert.ok(roleRows.some(row => row.sourceKey === 'ai-hub:admin:dsh-work-admin'))
  const access = await new PostgresAuthorizationService(database).authorizeWorkbench({
    userId,
    roleIds: ['role-employee', 'role-department-manager'],
    dataScopes,
  })
  assert.equal(access.roleIds.includes('role-platform-admin'), false)
  assert.equal(access.dataScopes.includes('organization:admin-only'), false)

  let refreshCalls = 0
  const rotatedAccessToken = secretBox.seal('rotated-access-token')
  const refreshOnce = async (latest: NonNullable<typeof stored>) => {
    if (latest.accessTokenEncrypted === rotatedAccessToken) return null
    refreshCalls += 1
    await new Promise(resolve => setTimeout(resolve, 25))
    return {
      accessTokenEncrypted: rotatedAccessToken,
      refreshTokenEncrypted: latest.refreshTokenEncrypted,
      tokenExpiresAt: new Date(Date.now() + 300_000),
      forceAuthorizationRefresh: false,
    }
  }
  const [firstRefresh, secondRefresh] = await Promise.all([
    repository.refreshTokensWithLock(sessionHash, 'workbench', refreshOnce),
    repository.refreshTokensWithLock(sessionHash, 'workbench', refreshOnce),
  ])
  assert.equal(refreshCalls, 1)
  assert.equal(firstRefresh?.accessTokenEncrypted, rotatedAccessToken)
  assert.equal(secondRefresh?.accessTokenEncrypted, rotatedAccessToken)

  await repository.revoke(sessionHash)
  assert.equal(await repository.findSession(sessionHash, 'workbench'), null)
})
