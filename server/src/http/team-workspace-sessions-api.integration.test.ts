import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresConversationRepository } from '../modules/workbench/application/postgres-conversation-repository.ts'
import { Router } from './router.ts'
import { registerConversationRoutes } from './workbench/conversation-routes.ts'

const tenantId = 'tenant-dsh-work'
const versionId = 'agent-version-dsh-work-assistant-1'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let conversations: PostgresConversationRepository
let server: Server
let baseUrl = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_sessions_api_test', maxConnections: 8 })
  database = throwaway.client
  conversations = new PostgresConversationRepository(database)
  const authorization = new PostgresAuthorizationService(database)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerConversationRoutes(
    router,
    conversations,
    undefined as never,
    undefined as never,
    undefined as never,
    authorization,
  )
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 团队 Session 分页（1B-T1）
// ---------------------------------------------------------------------------

test('团队 Session 列表按 Session 去重、游标稳定排序且不返回正文', async () => {
  const workspaceId = `ws-sessions-page`
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '会话负责人')
  await seedUser(memberId, '会话成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])

  // 同一会话 3 个 Run：列表必须只出现一次，并带 Run 计数与最新状态。
  const multi = await createSession(`${workspaceId}-multi`, workspaceId, ownerId, '季度复盘')
  await createRun(`${multi}-run-1`, multi, ownerId, 'succeeded', '2026-09-01T00:00:00.000Z')
  await createRun(`${multi}-run-2`, multi, ownerId, 'failed', '2026-09-02T00:00:00.000Z')
  const latest = await createRun(`${multi}-run-3`, multi, ownerId, 'running', '2026-09-03T00:00:00.000Z')

  const single = await createSession(`${workspaceId}-single`, workspaceId, ownerId, '库存异常排查')
  await createRun(`${single}-run-1`, single, ownerId, 'succeeded', '2026-09-04T00:00:00.000Z')
  await touchSession(single, '2026-09-04T00:00:00.000Z')
  await touchSession(multi, '2026-09-03T00:00:00.000Z')

  const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: ownerId })
  assert.equal(result.status, 200)
  const page = result.body.data as {
    items: Array<Record<string, unknown>>
    nextCursor: string | null
  }
  assert.deepEqual(page.items.map(item => item.sessionId), [single, multi], '按最近活动倒序，且同一会话只出现一次')
  const multiItem = page.items.find(item => item.sessionId === multi)
  assert.equal(multiItem?.runCount, 3)
  assert.equal((multiItem?.latestRun as { id: string }).id, latest, '取该会话最近的 Run 作为指针')
  assert.equal((multiItem?.latestRun as { status: string }).status, 'running')
  assert.equal(multiItem?.creatorName, '会话负责人')
  assert.equal(multiItem?.title, '季度复盘')
  // 摘要不得携带对话正文。
  assert.equal(JSON.stringify(page.items).includes('季度复盘内容'), false)
})

test('团队 Session 列表按标题搜索并支持游标翻页到末尾', async () => {
  const workspaceId = 'ws-sessions-cursor'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '分页负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  for (const index of [1, 2, 3]) {
    const sessionId = `${workspaceId}-s${index}`
    await createSession(sessionId, workspaceId, ownerId, `巡检记录 ${index}`)
    await createRun(`${sessionId}-run`, sessionId, ownerId, 'succeeded', `2026-09-0${index}T00:00:00.000Z`)
    await touchSession(sessionId, `2026-09-0${index}T00:00:00.000Z`)
  }
  const other = `${workspaceId}-other`
  await createSession(other, workspaceId, ownerId, '无关标题')
  await createRun(`${other}-run`, other, ownerId, 'succeeded', '2026-09-05T00:00:00.000Z')
  await touchSession(other, '2026-09-05T00:00:00.000Z')

  const filtered = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?query=${encodeURIComponent('巡检记录')}`, { as: ownerId })
  assert.equal(filtered.status, 200)
  assert.deepEqual(
    (filtered.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [`${workspaceId}-s3`, `${workspaceId}-s2`, `${workspaceId}-s1`],
  )

  const first = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=2`, { as: ownerId })
  const firstPage = first.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.equal(firstPage.items.length, 2)
  assert.ok(firstPage.nextCursor, '还有更多时应返回游标')

  const second = await api(
    'GET',
    `/api/workbench/v1/workspaces/${workspaceId}/sessions?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
    { as: ownerId },
  )
  const secondPage = second.body.data as { items: Array<{ sessionId: string }>; nextCursor: string | null }
  assert.equal(secondPage.items.length, 2)
  assert.equal(secondPage.nextCursor, null, '翻到末尾时不再返回游标')

  const seen = [...firstPage.items, ...secondPage.items].map(item => item.sessionId)
  assert.equal(new Set(seen).size, 4, '两页合起来覆盖全部 4 个会话且不重复')
})

test('团队 Session 列表对所有成员可读，非成员被拒绝，个人空间被拒绝', async () => {
  const workspaceId = 'ws-sessions-access'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '访问负责人')
  await seedUser(memberId, '访问成员')
  await seedUser(viewerId, '访问只读')
  await seedUser(outsiderId, '访问外部人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  const sessionId = `${workspaceId}-session`
  await createSession(sessionId, workspaceId, ownerId, '只读可见性')
  await createRun(`${sessionId}-run`, sessionId, ownerId, 'succeeded', '2026-09-06T00:00:00.000Z')

  for (const userId of [ownerId, memberId, viewerId]) {
    const result = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: userId })
    assert.equal(result.status, 200, `${userId} 应可读取团队会话列表`)
  }

  // 1B 默认本人范围（TW-03 本人历史列表）：成员看不到别人发起的会话。
  const asMember = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: memberId })
  assert.deepEqual((asMember.body.data as { items: unknown[] }).items, [], '成员本人尚无会话时为空')
  // 2A 的「团队共享」范围可以读到其他成员的会话。
  const asTeam = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?scope=team`, { as: memberId })
  assert.deepEqual(
    (asTeam.body.data as { items: Array<{ sessionId: string }> }).items.map(item => item.sessionId),
    [sessionId],
  )
  const badScope = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions?scope=all`, { as: ownerId })
  assert.equal(badScope.status, 422, '未知 scope 被拒绝')

  const outsider = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/sessions`, { as: outsiderId })
  assert.equal(outsider.status, 403, '非成员不得读取团队会话列表')

  // 0013 触发器在插入 users 时已自动创建个人空间，直接用它，不要重复插入。
  const personalUserId = 'user-sessions-personal'
  await seedUser(personalUserId, '个人空间用户')
  const personal = await api('GET', `/api/workbench/v1/workspaces/ws-personal-${personalUserId}/sessions`, {
    as: personalUserId,
  })
  assert.equal(personal.status, 422, '个人空间不提供团队会话分页')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测',
      role: 'employee', dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

async function seedTeamWorkspace(
  workspaceId: string,
  members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>,
) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '1B 会话分页测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function createSession(sessionId: string, workspaceId: string, userId: string, title: string) {
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, ${versionId}, ${title}, 'active')
  `
  return sessionId
}

async function createRun(runId: string, sessionId: string, userId: string, status: string, createdAt: string) {
  await database`
    insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, created_at, updated_at)
    values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, ${status}, ${createdAt}, ${createdAt})
  `
  return runId
}

async function touchSession(sessionId: string, at: string) {
  await database`update sessions set last_active_at = ${at} where tenant_id = ${tenantId} and id = ${sessionId}`
}

async function api(method: string, path: string, options: { as?: string } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.as) headers['x-test-user-id'] = options.as
  const response = await fetch(`${baseUrl}${path}`, { method, headers })
  const body = await response.json().catch(() => null) as { data?: unknown; error?: { message: string } }
  return { status: response.status, body }
}
