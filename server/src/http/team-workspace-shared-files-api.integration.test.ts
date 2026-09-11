import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let content: PostgresContentService
let workspaceMembers: PostgresWorkspaceMemberService
let server: ReturnType<typeof createServer>
let baseUrl = ''
let storageRoot = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_shared_files_api_test', maxConnections: 8 })
  database = throwaway.client
  // 本套件只验证列表/移除/下载门禁，不需要真实解析：给一个临时存储根即可。
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-shared-files-'))
  const authorization = new PostgresAuthorizationService(database)
  content = new PostgresContentService(database, storageRoot, authorization)
  workspaceMembers = new PostgresWorkspaceMemberService(database, authorization)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
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
// 文件与结果读取收权（1B-T4 / AC-09；个人空间 AC-23）
// ---------------------------------------------------------------------------

test('被移出团队的成员不能再下载本人团队会话文件，现任成员与个人空间作者不受影响', async () => {
  const workspaceId = 'ws-revoke-file'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const currentId = `${workspaceId}-current`
  await seedUser(ownerId, '收权负责人')
  await seedUser(memberId, '收权成员')
  await seedUser(currentId, '收权现任成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: currentId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '巡检结论.txt', content: '团队会话文件正文',
  })

  // 移除前：本人（会话作者）可下载，同时让授权缓存进入已授予状态，以便验证成员
  // 变更后的撤权修订号能立即失效缓存，而不是靠 TTL 过期。
  assert.equal((await content.readFile(fileId, memberId)).bytes.toString('utf8'), '团队会话文件正文')
  // 该文件挂在 memberId 的私有会话下：空间成员身份不构成读取依据（AC-10 / §5）。
  await assert.rejects(content.readFile(fileId, currentId), /文件不存在或不可访问/)

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)

  // 空间共享文件（session_id 为空）对现任成员保持可下载——收权检查不能过宽。
  const sharedFileId = `${workspaceId}-shared-file`
  await seedFile({ id: sharedFileId, workspaceId, name: '共享巡检.txt', uploadedBy: ownerId })
  await storeSharedFileBytes(sharedFileId, '共享正文')
  assert.equal((await content.readFile(sharedFileId, currentId)).bytes.toString('utf8'), '共享正文')
  assert.equal((await content.readFile(sharedFileId, ownerId)).bytes.toString('utf8'), '共享正文')
})

test('主动退出团队的成员同样不能下载团队文件与成果', async () => {
  const workspaceId = 'ws-exit-file'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '退出负责人')
  await seedUser(memberId, '退出成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '退出前文件.txt', content: '退出前正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)

  await workspaceMembers.exitWorkspace(workspaceId, memberId)

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
})

test('被移出团队的成员不能再下载本人团队成果与历史版本，现任成员的成果不受影响', async () => {
  const workspaceId = 'ws-revoke-artifact'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const currentId = `${workspaceId}-current`
  await seedUser(ownerId, '成果负责人')
  await seedUser(memberId, '成果成员')
  await seedUser(currentId, '成果现任成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: currentId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const runId = await seedRun(sessionId, memberId)
  const fileId = `${workspaceId}-artifact-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '成果.txt', content: '成果正文',
  })
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  // 现任成员（成果作者）在移除前可下载 artifact 与指定版本（检查不能过宽）。
  assert.equal(await content.artifactFileId(artifactId, undefined, memberId), fileId)
  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)
  assert.equal(
    (await content.readFile(await content.artifactFileId(artifactId, 1, memberId), memberId)).bytes.toString('utf8'),
    '成果正文',
  )

  // 同一成员的个人空间成果：用于验证成果列表在失权后只过滤团队成果（AC-23）。
  const personalWorkspace = `ws-personal-${memberId}`
  const personalSession = await seedSession(personalWorkspace, memberId)
  const personalRun = await seedRun(personalSession, memberId)
  const personalFile = `${personalWorkspace}-file`
  await seedStoredFile({
    id: personalFile, workspaceId: personalWorkspace, sessionId: personalSession, uploadedBy: memberId, name: '个人成果.txt', content: '个人正文',
  })
  const personalArtifact = `${personalWorkspace}-artifact`
  await seedArtifact({
    artifactId: personalArtifact, workspaceId: personalWorkspace, sessionId: personalSession, createdBy: memberId,
    fileId: personalFile, runId: personalRun,
  })
  assert.deepEqual(
    new Set((await content.listArtifacts(memberId)).map(artifact => artifact.id)),
    new Set([artifactId, personalArtifact]),
    '失权前团队成果与个人成果都可见',
  )

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, 1, memberId), /Artifact 不存在或不可访问/)
  // 失权成员命中 artifact 的旧文件 ID 也必须被拒绝（artifactFileId → readFile 双重口径）。
  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  // 失权后：团队成果不再返回，同一成员的个人成果保留。
  assert.deepEqual(
    (await content.listArtifacts(memberId)).map(artifact => artifact.id),
    [personalArtifact],
    '被移出成员的团队成果不再返回，个人成果保留',
  )

  // 另一名现任成员只能看到并下载自己的成果；被移出成员的成果不因空间仍在而放行。
  const currentSession = await seedSession(workspaceId, currentId)
  const currentRun = await seedRun(currentSession, currentId)
  const currentFile = `${workspaceId}-current-file`
  await seedStoredFile({
    id: currentFile, workspaceId, sessionId: currentSession, uploadedBy: currentId, name: '现任成果.txt', content: '现任正文',
  })
  const currentArtifact = `${workspaceId}-current-artifact`
  await seedArtifact({
    artifactId: currentArtifact, workspaceId, sessionId: currentSession, createdBy: currentId, fileId: currentFile, runId: currentRun,
  })
  assert.equal(await content.artifactFileId(currentArtifact, 1, currentId), currentFile)
})

test('Run 输入挂载不得读取他人私有会话附件，但可挂载空间共享文件', async () => {
  const workspaceId = 'ws-mount-scope'
  const ownerId = `${workspaceId}-owner`
  const authorId = `${workspaceId}-author`
  const otherId = `${workspaceId}-other`
  await seedUser(ownerId, '挂载负责人')
  await seedUser(authorId, '挂载作者')
  await seedUser(otherId, '挂载他人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: authorId, role: 'member' },
    { userId: otherId, role: 'member' },
  ])

  // author 的私有会话附件：只有 author 能挂进自己的 Run。
  const authorSession = await seedSession(workspaceId, authorId)
  const privateFileId = `${workspaceId}-private-file`
  await seedStoredFile({
    id: privateFileId, workspaceId, sessionId: authorSession, uploadedBy: authorId, name: '私有.txt', content: '机密私有正文',
  })
  await seedExtraction(privateFileId, '机密私有解析正文')

  const otherSession = await seedSession(workspaceId, otherId)
  for (const actorId of [otherId, ownerId]) {
    await assert.rejects(
      content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [privateFileId], userId: actorId }),
      /不存在、不可访问或解析未成功/,
      `${actorId} 不得把他人私有会话附件挂进 Run 输入（负责人身份也不构成依据）`,
    )
  }
  const authorOwn = await content.prepareRuntimeFiles({ sessionId: authorSession, fileIds: [privateFileId], userId: authorId })
  assert.equal(authorOwn.length, 1, '作者本人仍可挂载自己的会话附件')

  // 作者把**自己另一个会话**的附件挂进自己的新会话：既有行为，保持可用（AC-23）。
  const authorSecondSession = await seedSession(workspaceId, authorId)
  const crossSession = await content.prepareRuntimeFiles({
    sessionId: authorSecondSession, fileIds: [privateFileId], userId: authorId,
  })
  assert.equal(crossSession.length, 1, '本人跨会话附件仍可挂载')

  // 空间共享文件（session_id 为空）：现任成员可挂载。
  const sharedFileId = `${workspaceId}-shared-mount`
  await seedFile({ id: sharedFileId, workspaceId, name: '共享挂载.txt', uploadedBy: ownerId })
  await seedExtraction(sharedFileId, '共享解析正文')
  const mounted = await content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [sharedFileId], userId: otherId })
  assert.equal(mounted.length, 1, '空间共享文件对现任成员保持可挂载')
})

test('个人空间作者的文件与成果下载保持现状（AC-23）', async () => {
  const userId = 'user-personal-read'
  await seedUser(userId, '个人空间作者')
  // users 触发器已自动开通个人空间（migration 0013）。
  const workspaceId = `ws-personal-${userId}`
  const sessionId = await seedSession(workspaceId, userId)
  const fileId = `${workspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: userId, name: '个人文件.txt', content: '个人文件正文',
  })
  const runId = await seedRun(sessionId, userId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: userId, fileId, runId })

  assert.equal((await content.readFile(fileId, userId)).bytes.toString('utf8'), '个人文件正文')
  assert.equal(await content.artifactFileId(artifactId, undefined, userId), fileId)
  assert.equal(await content.artifactFileId(artifactId, 1, userId), fileId)
  const listed = await content.listArtifacts(userId)
  assert.deepEqual(listed.map(artifact => artifact.id), [artifactId])
})

test('下载接口在失权后返回 403，且与不存在同口径不泄露对象存在性', async () => {
  const workspaceId = 'ws-revoke-http'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '接口负责人')
  await seedUser(memberId, '接口成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '接口文件.txt', content: '接口正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  const beforeRemoval = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(beforeRemoval.status, 200)

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  const fileResponse = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(fileResponse.status, 403)
  assert.match(await fileResponse.text(), /文件不存在或不可访问/)

  const artifactResponse = await fetch(`${baseUrl}/api/workbench/v1/artifacts/${artifactId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(artifactResponse.status, 403)
  assert.match(await artifactResponse.text(), /Artifact 不存在或不可访问/)
})

test('归档团队空间后文件、成果与运行读取一律 fail-closed，不因授权缓存命中而放行', async () => {
  const workspaceId = 'ws-archived-read'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档负责人')
  await seedUser(memberId, '归档成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '归档前文件.txt', content: '归档前正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  // 归档前先读一次，把授权缓存预热到「已授予」——归档不提升 team_auth_revision，
  // 因此缓存命中的旧实现会继续放行（评审实测的 TTL 依赖缺陷）。
  assert.equal((await content.readFile(fileId, memberId)).bytes.toString('utf8'), '归档前正文')
  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)

  await database`
    update workspaces set status = 'archived' where tenant_id = ${tenantId} and id = ${workspaceId}
  `

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
  assert.deepEqual(await content.listArtifacts(memberId), [], '归档空间成果不再出现在列表')

  // 与团队运行读取同一口径：归档空间的结果读取不得 fail-open。
  const response = await fetch(`${baseUrl}/api/workbench/v1/artifacts/${artifactId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(response.status, 403)
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

/** 让共享/会话文件进入可挂载状态：成功的 m4-basic-v1 解析结果。 */
async function seedExtraction(fileId: string, text: string) {
  const extractionId = `${fileId}-extraction`
  const storageKey = `storage/${extractionId}.txt`
  const target = join(storageRoot, storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text)
  await database`
    insert into file_extractions (
      id, tenant_id, file_id, extractor_version, detected_type, status,
      text_storage_key, text_sha256, character_count, created_at
    ) values (
      ${extractionId}, ${tenantId}, ${fileId}, 'm4-basic-v1', 'text', 'succeeded',
      ${storageKey}, ${'c'.repeat(64)}, ${text.length}, now()
    )
  `
}

/** 空间共享文件的行由 `seedFile` 建立，这里补上磁盘字节以便真正下载。 */
async function storeSharedFileBytes(fileId: string, content: string) {
  const [row] = await database<{ storageKey: string }[]>`
    select storage_key as "storageKey" from file_objects
     where tenant_id = ${tenantId} and id = ${fileId}
  `
  if (!row) throw new Error(`file object ${fileId} not seeded`)
  const target = join(storageRoot, row.storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/** Real team/personal session owned by `userId`; artifacts/files hang off it. */
async function seedSession(workspaceId: string, userId: string) {
  const sessionId = `session-${randomUUID()}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, 'agent-version-dsh-work-assistant-1', '收权验证会话', 'active')
  `
  return sessionId
}

/** Terminal run + attempt so `artifact_versions.source_run_id` can be satisfied. */
async function seedRun(sessionId: string, userId: string) {
  const runId = `run-${randomUUID()}`
  const attemptId = `${runId}-attempt`
  await database.begin(async transaction => {
    await transaction`
      insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
      values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
    `
    await transaction`
      insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
      values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${database.json({})}, 'x', ${database.json({})}, 'succeeded')
    `
  })
  return runId
}

/** File object attached to a session, with the bytes really present on disk. */
async function seedStoredFile(input: {
  id: string
  workspaceId: string
  sessionId: string
  name: string
  uploadedBy: string
  content: string
}) {
  const storageKey = `storage/${input.id}`
  const target = join(storageRoot, storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, input.content)
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${input.id}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${storageKey}, ${input.name},
      'text/plain', ${Buffer.byteLength(input.content)}, ${'a'.repeat(64)}, 'clean', ${input.uploadedBy}
    )
  `
}

async function seedArtifact(input: {
  artifactId: string
  workspaceId: string
  sessionId: string
  createdBy: string
  fileId: string
  runId: string
  version?: number
}) {
  await database`
    insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
    values (${input.artifactId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${`${input.artifactId}.txt`}, 'text', ${input.createdBy})
  `
  await database`
    insert into artifact_versions (id, tenant_id, artifact_id, version_no, file_object_id, source_run_id)
    values (${`${input.artifactId}-v${input.version ?? 1}`}, ${tenantId}, ${input.artifactId}, ${input.version ?? 1}, ${input.fileId}, ${input.runId})
  `
}
