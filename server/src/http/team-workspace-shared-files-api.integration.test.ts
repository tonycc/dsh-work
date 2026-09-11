import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let content: PostgresContentService
let server: ReturnType<typeof createServer>
let storageRoot = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_shared_files_api_test', maxConnections: 8 })
  database = throwaway.client
  // 本套件只验证列表/移除/下载门禁，不需要真实写入：给一个临时存储根即可。
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-shared-files-'))
  content = new PostgresContentService(database, storageRoot)
  const authorization = new PostgresAuthorizationService(database)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 共享文件列表与逻辑移除（1B-T3）
// ---------------------------------------------------------------------------

test('共享文件列表支持名称搜索与游标分页，且不含已移除文件', async () => {
  const workspaceId = 'ws-files-list'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '文件负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  for (const index of [1, 2, 3]) {
    await seedFile({
      id: `${workspaceId}-f${index}`,
      workspaceId,
      name: `巡检记录-${index}.xlsx`,
      uploadedBy: ownerId,
      createdAt: `2026-09-0${index}T00:00:00.000Z`,
    })
  }
  await seedFile({ id: `${workspaceId}-other`, workspaceId, name: '无关文件.pdf', uploadedBy: ownerId, createdAt: '2026-09-05T00:00:00.000Z' })
  const removed = `${workspaceId}-removed`
  await seedFile({ id: removed, workspaceId, name: '巡检记录-移除.xlsx', uploadedBy: ownerId, createdAt: '2026-09-06T00:00:00.000Z' })
  await database`update file_objects set removed_at = now() where tenant_id = ${tenantId} and id = ${removed}`

  const filtered = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, query: '巡检记录' })
  assert.deepEqual(filtered.items.map(item => item.id), [`${workspaceId}-f3`, `${workspaceId}-f2`, `${workspaceId}-f1`])

  const first = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 2 })
  assert.equal(first.items.length, 2)
  assert.ok(first.nextCursor, '还有更多时返回游标')
  const second = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 2, cursor: first.nextCursor ?? undefined })
  const seen = [...first.items, ...second.items].map(item => item.id)
  assert.equal(new Set(seen).size, 4, '两页覆盖全部 4 个未移除文件且不重复')
  assert.equal(second.nextCursor, null, '到末尾不再返回游标')
})

test('可选动作由服务端按角色判定：负责人可移除全部，成员仅自己上传的，只读成员不可移除', async () => {
  const workspaceId = 'ws-files-perms'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  await seedUser(ownerId, '权限负责人')
  await seedUser(memberId, '权限成员')
  await seedUser(viewerId, '权限只读')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await seedFile({ id: `${workspaceId}-by-owner`, workspaceId, name: '负责人上传.xlsx', uploadedBy: ownerId, createdAt: '2026-09-01T00:00:00.000Z' })
  await seedFile({ id: `${workspaceId}-by-member`, workspaceId, name: '成员上传.xlsx', uploadedBy: memberId, createdAt: '2026-09-02T00:00:00.000Z' })

  const asOwner = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.deepEqual(asOwner.items.map(item => [item.id, item.removable]), [
    [`${workspaceId}-by-member`, true],
    [`${workspaceId}-by-owner`, true],
  ], '负责人可移除两个文件')

  const asMember = await content.listWorkspaceFiles({ workspaceId, actorUserId: memberId })
  assert.deepEqual(asMember.items.map(item => [item.id, item.removable]), [
    [`${workspaceId}-by-member`, true],
    [`${workspaceId}-by-owner`, false],
  ])

  const asViewer = await content.listWorkspaceFiles({ workspaceId, actorUserId: viewerId })
  assert.equal(asViewer.items.every(item => item.removable), false, '只读成员不可移除任何文件')
  assert.equal(asViewer.items.every(item => item.canDownload), true, '只读成员仍可下载')

  await assert.rejects(
    content.removeWorkspaceFile(workspaceId, `${workspaceId}-by-owner`, memberId),
    /只有负责人、管理员或上传人本人/,
  )
  await assert.rejects(
    content.removeWorkspaceFile(workspaceId, `${workspaceId}-by-member`, viewerId),
    /只有负责人、管理员或上传人本人/,
  )
})

test('逻辑移除保留对象与历史引用，旧 ID 下载被拒绝', async () => {
  const workspaceId = 'ws-files-remove'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '移除负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const fileId = `${workspaceId}-file`
  await seedFile({ id: fileId, workspaceId, name: '待移除.xlsx', uploadedBy: ownerId })
  // 历史 Run 引用该文件，移除后必须仍可追溯。
  const sessionId = `${workspaceId}-session`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${ownerId}, 'agent-version-dsh-work-assistant-1', '历史会话', 'active')
  `
  const runId = `${workspaceId}-run`
  const attemptId = `${runId}-attempt`
  // runs.current_attempt_id 有可延迟外键，两行必须在同一事务内提交。
  await database.begin(async transaction => {
    await transaction`
      insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
      values (${runId}, ${tenantId}, ${sessionId}, ${ownerId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
    `
    await transaction`
      insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
      values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${database.json({})}, 'x', ${database.json({})}, 'succeeded')
    `
  })
  const extractionId = `${runId}-extraction`
  await database`
    insert into file_extractions (
      id, tenant_id, file_id, extractor_version, detected_type, status,
      text_storage_key, text_sha256, character_count, created_at
    ) values (
      ${extractionId}, ${tenantId}, ${fileId}, 'v1', 'xlsx', 'succeeded',
      ${`storage/${extractionId}.txt`}, ${'b'.repeat(64)}, 12, now()
    )
  `
  await database`
    insert into run_input_files (id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path)
    values (${`${runId}-input`}, ${tenantId}, ${runId}, ${attemptId}, ${fileId}, ${extractionId}, '/workspace/input/待移除.txt')
  `

  const removed = await content.removeWorkspaceFile(workspaceId, fileId, ownerId)
  assert.deepEqual(removed, { id: fileId, removed: true })

  // 对象仍在，历史引用仍在。
  const [row] = await database<{ removedAt: Date | null; count: number }[]>`
    select f.removed_at as "removedAt",
           (select count(*)::integer from run_input_files rif
             where rif.tenant_id = f.tenant_id and rif.file_id = f.id) as count
      from file_objects f where f.tenant_id = ${tenantId} and f.id = ${fileId}
  `
  assert.ok(row?.removedAt, '保留移除时间戳')
  assert.equal(row?.count, 1, '历史 Run 的文件引用保留')

  // 列表不再出现，旧 ID 下载被拒绝。
  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.equal(listed.items.some(item => item.id === fileId), false)
  await assert.rejects(content.readFile(fileId, ownerId), /文件不存在或不可访问/)

  // 已移除文件的重复移除是幂等的。
  assert.deepEqual(await content.removeWorkspaceFile(workspaceId, fileId, ownerId), { id: fileId, removed: true })
})

test('非成员与个人空间不能列出或移除共享文件', async () => {
  const workspaceId = 'ws-files-access'
  const ownerId = `${workspaceId}-owner`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '访问文件负责人')
  await seedUser(outsiderId, '访问文件外部人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await seedFile({ id: `${workspaceId}-file`, workspaceId, name: '共享.xlsx', uploadedBy: ownerId })

  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId, actorUserId: outsiderId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )

  const personalUserId = 'user-files-personal'
  await seedUser(personalUserId, '文件个人空间用户')
  const personalWorkspaceId = `ws-personal-${personalUserId}`
  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId: personalWorkspaceId, actorUserId: personalUserId }),
    /仅支持团队工作空间/,
  )
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
    values (${workspaceId}, ${tenantId}, '1B 共享文件测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function seedFile(input: {
  id: string
  workspaceId: string
  name: string
  uploadedBy: string
  createdAt?: string
}) {
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by, created_at
    ) values (
      ${input.id}, ${tenantId}, ${input.workspaceId}, null, ${`storage/${input.id}`}, ${input.name},
      'application/octet-stream', 2048, ${'a'.repeat(64)}, 'clean', ${input.uploadedBy},
      ${input.createdAt ?? new Date().toISOString()}
    )
  `
}
