import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import {
  envelope,
  httpResult,
  readJsonBody,
  requireRequestIdentity,
  sessionAuthorizationContext,
  type Router,
} from '../router.ts'

const basePath = '/api/workbench/v1'

export function registerContentRoutes(
  router: Router,
  content: PostgresContentService,
  authorization?: PostgresAuthorizationService,
) {
  router.get(`${basePath}/workspaces`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    return envelope('workbench', await content.listWorkspaces(userId), 'postgres')
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
