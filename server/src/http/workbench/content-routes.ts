import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

function parseFilePageLimit(raw: string | null) {
  if (raw === null || raw === '') return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1 到 100 之间的整数')
  return limit
}

/**
 * Workspace lifecycle filter (3-T2). Defaults to `all` per the confirmed design
 * decision (设计 §2.1/§6「默认全部；个人空间恒显」): with a default of `active`
 * an archived workspace would be undiscoverable in the UI, which would defeat
 * 3-T2. `active`/`archived` power the 3-T3 筛选. Anything else is an explicit
 * 422 rather than a silently ignored parameter.
 */
function parseWorkspaceStatus(raw: string | null): 'active' | 'archived' | 'all' {
  // 默认 all：设计 §2.1 与 §6 已确认决策「默认全部；个人空间恒显」，且归档空间必须
  // 在默认视图里可发现，否则 3-T2 做完也无法从 UI 进入归档详情。
  if (raw === null || raw === '') return 'all'
  if (raw === 'active' || raw === 'archived' || raw === 'all') return raw
  throw routeValidationFailed('status 必须为 active、archived 或 all')
}

export function registerContentRoutes(
  router: Router,
  content: PostgresContentService,
  authorization?: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const status = parseWorkspaceStatus(context.url.searchParams.get('status'))
    return envelope('workbench', await content.listWorkspaces(userId, { status }), 'postgres')
  })

  router.post(`${basePath}/workspaces`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const body = await readJsonBody<{ name: string; description?: string }>(request)
    if (body.name.trim().length < 2) throw new Error('工作空间名称至少需要 2 个字符')
    return httpResult(201, envelope('workbench', await content.createWorkspace({
      name: body.name,
      description: body.description ?? '',
    }, userId), 'postgres'))
  })

  // 3-T3 依赖：团队空间名称/说明保存（1A 遗留的 PATCH）。仅负责人；清空说明显式传 null。
  router.patch(`${basePath}/workspaces/:workspaceId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<{ name?: unknown; description?: unknown } | null>(request)
    // JSON `null` 能通过 JSON.parse，但不是对象：直接读 body.name 会抛 TypeError 并被
    // 分类成 500。契约的 requestBody 是 object，这里显式 422（质量评审 F8）。
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw routeValidationFailed('请求体必须是 JSON 对象')
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw routeValidationFailed('name 必须是字符串')
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw routeValidationFailed('description 必须是字符串或 null')
    }
    return envelope(
      'workbench',
      await content.updateWorkspace(
        context.params['workspaceId'] ?? '',
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description as string | null }),
        },
        identity.userId,
      ),
      'postgres',
    )
  })

  router.get(`${basePath}/artifacts`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    return envelope('workbench', await content.listArtifacts(userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/files`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId: context.params['workspaceId'],
      ...sessionAuthorizationContext(identity),
    })
    const fileNameHeader = request.headers['x-file-name']
    const encodedName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader
    if (!encodedName) throw new Error('缺少文件名')
    const name = decodeURIComponent(encodedName)
    const bytes = await readBinaryBody(request, 20 * 1024 * 1024)
    const file = await content.storeWorkspaceFile(
      context.params['workspaceId'] ?? '',
      name,
      request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
      userId,
    )
    return httpResult(201, envelope('workbench', file, 'postgres'))
  })

  // 共享文件列表属读取轨（3-T1）：路由闸门必须跟服务层同轨，否则归档空间会在路由层
  // 被 403、读轨代码不可达（符合性评审 P1-1）。
  router.get(`${basePath}/workspaces/:workspaceId/files`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    const limit = parseFilePageLimit(context.url.searchParams.get('limit'))
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope(
      'workbench',
      await content.listWorkspaceFiles({ workspaceId, actorUserId: userId, query, cursor, limit }),
      'postgres',
    )
  })

  // 逻辑移除（1B-T3）：负责人/管理员可移除任何文件，成员仅可移除自己上传的；
  // 文件对象、解析结果与历史 Run 引用保留（AC-13）。
  router.delete(`${basePath}/workspaces/:workspaceId/files/:fileId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
    })
    return envelope(
      'workbench',
      await content.removeWorkspaceFile(workspaceId, context.params['fileId'] ?? '', userId),
      'postgres',
    )
  })

  router.post(`${basePath}/sessions/:sessionId/files`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const fileNameHeader = request.headers['x-file-name']
    const encodedName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader
    if (!encodedName) throw new Error('缺少文件名')
    const name = decodeURIComponent(encodedName)
    const bytes = await readBinaryBody(request, 20 * 1024 * 1024)
    const file = await content.storeSessionFile(
      context.params['sessionId'] ?? '',
      name,
      request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
      userId,
    )
    return httpResult(201, envelope('workbench', file, 'postgres'))
  })

  router.get(`${basePath}/files/:fileId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const file = await content.readFile(context.params['fileId'] ?? '', userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })

  router.get(`${basePath}/artifacts/:artifactId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const fileId = await content.artifactFileId(context.params['artifactId'] ?? '', undefined, userId)
    const file = await content.readFile(fileId, userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })

  router.get(`${basePath}/artifacts/:artifactId/versions/:versionId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const version = Number(context.params['versionId'])
    if (!Number.isInteger(version) || version < 1) throw new Error('Artifact 版本号无效')
    const fileId = await content.artifactFileId(context.params['artifactId'] ?? '', version, userId)
    const file = await content.readFile(fileId, userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxBytes) throw new Error('文件超过 20 MB 限制')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function writeDownload(response: ServerResponse, name: string, mimeType: string, bytes: Buffer) {
  const safeName = name.replace(/[\r\n"]/g, '_')
  response.writeHead(200, {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Content-Length': bytes.length,
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(bytes)
}
