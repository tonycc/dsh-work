import { accessDenied } from '../../domain/request-errors.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import {
  DATA_PROTECTION_TERMS_PERMISSION,
  normalizeAllowValue,
  normalizePreviewText,
  normalizeTermInputs,
  parseDataProtectionFilter,
  type DataProtectionAdminPort,
} from '../../domain/data-protection.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router, type RouteContext } from '../router.ts'

const basePath = '/api/admin/v1/data-protection'

/** 词表和白名单是机密内容：查看也需要单独授权，不默认给所有管理员（方案 5.8）。 */
function requireTermAccess(context: RouteContext) {
  const identity = requireRequestIdentity(context, 'admin')
  if (!identity.permissions.includes('admin:*') && !identity.permissions.includes(DATA_PROTECTION_TERMS_PERMISSION)) {
    throw accessDenied('当前用户没有数据防护词表权限')
  }
  return identity
}

export function registerDataProtectionRoutes(
  router: Router,
  service: DataProtectionAdminPort,
  audit: AuditTrail | undefined,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  // 变更只记谁在何时增删了多少条，不记词条内容（方案 5.8）。
  const record = async (actorId: string, action: string, detail: string) => {
    await audit?.appendAudit(actorId, action, 'data-protection', 'success', `trace-data-protection-${Date.now()}`, detail, 'data_protection')
  }

  router.get(`${basePath}/overview`, async (_request, context) =>
    envelope('admin', await service.getOverview(parseDataProtectionFilter(context.url.searchParams)), adapter))
  router.get(`${basePath}/records`, async (_request, context) => {
    const params = context.url.searchParams
    const page = clamp(Number(params.get('page') ?? 1), 1, 1_000_000, 1)
    const pageSize = clamp(Number(params.get('page_size') ?? 20), 1, 100, 20)
    return envelope('admin', await service.getRecords(parseDataProtectionFilter(params), page, pageSize), adapter)
  })
  router.post(`${basePath}/preview`, async (request, context) => {
    requireRequestIdentity(context, 'admin')
    const body = await readJsonBody<{ text?: unknown } | null>(request)
    return envelope('admin', await service.preview(normalizePreviewText(body?.text)), adapter)
  })

  router.get(`${basePath}/terms`, async (_request, context) => {
    requireTermAccess(context)
    return envelope('admin', await service.listTerms(), adapter)
  })
  router.post(`${basePath}/terms`, async (request, context) => {
    const identity = requireTermAccess(context)
    const body = await readJsonBody<{ terms?: unknown } | null>(request)
    const result = await service.addTerms(normalizeTermInputs(body?.terms))
    await record(identity.userId, 'data-protection.terms.add', `新增 ${result.added} 条，跳过 ${result.skipped} 条`)
    return envelope('admin', result, adapter)
  })
  router.delete(`${basePath}/terms/:id`, async (_request, context) => {
    const identity = requireTermAccess(context)
    await service.removeTerm(context.params['id'] ?? '')
    await record(identity.userId, 'data-protection.terms.remove', '删除 1 条')
    return envelope('admin', { removed: true }, adapter)
  })

  router.get(`${basePath}/allowlist`, async (_request, context) => {
    requireTermAccess(context)
    return envelope('admin', await service.listAllowlist(), adapter)
  })
  router.post(`${basePath}/allowlist`, async (request, context) => {
    const identity = requireTermAccess(context)
    const body = await readJsonBody<{ value?: unknown } | null>(request)
    const result = await service.addAllow(normalizeAllowValue(body?.value))
    await record(identity.userId, 'data-protection.allowlist.add', result.added ? '新增 1 条' : '已存在，未新增')
    return envelope('admin', result, adapter)
  })
  router.delete(`${basePath}/allowlist/:id`, async (_request, context) => {
    const identity = requireTermAccess(context)
    await service.removeAllow(context.params['id'] ?? '')
    await record(identity.userId, 'data-protection.allowlist.remove', '删除 1 条')
    return envelope('admin', { removed: true }, adapter)
  })
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback
}
