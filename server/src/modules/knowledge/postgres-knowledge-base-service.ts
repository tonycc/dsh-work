import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { AuditTrail } from '../../domain/audit-trail.ts'
import { accessDenied, dependencyUnavailable, invalidRequest, notFound, RequestError, stateConflict } from '../../domain/request-errors.ts'
import { knowledgeLevelOf, visibleBaseIdsSql, type KnowledgeLevel } from './knowledge-access.ts'
import {
  maxKnowledgeUploadBytes,
  maxSessionKnowledgeBases,
  type KnowledgeBaseService,
  type KnowledgeBaseView,
  type KnowledgeDepartmentOption,
  type KnowledgeDocumentStatus,
  type KnowledgeDocumentView,
  type KnowledgeGrantView,
  type KnowledgeStatusView,
  type SessionKnowledgeBaseView,
} from './knowledge-base-service.ts'
import { WeKnoraClient, WeKnoraRequestError, WeKnoraUnavailableError, type WeKnoraDocument } from './weknora-client.ts'

const tenantId = 'tenant-dsh-work'
const levelRank: Record<KnowledgeLevel, number> = { none: 0, view: 1, docs: 2, bases: 3 }
const maxPreviewBytes = 200 * 1024

interface BaseRow {
  id: string
  externalId: string
  name: string
  description: string
  ownerDepartmentId: string
  ownerDepartmentName: string
  ownedByMe: boolean
}

interface GrantRow extends KnowledgeGrantView {
  knowledgeBaseId: string
}

export interface PostgresKnowledgeBaseServiceConfig {
  connectionId: string
  client: WeKnoraClient | null
  embeddingModelId?: string
}

/**
 * 员工端知识库与文档管理（weknora-knowledge-plan 第 5、8 节）。权限全部由平台校验：查看要求
 * 知识库当前对员工可见，管理要求知识库归属员工直接所属的部门且具备对应级别（5.2）；文档 ID
 * 必须属于该知识库。WeKnora 只做存储与解析，员工浏览器不直接访问它。
 */
export class PostgresKnowledgeBaseService implements KnowledgeBaseService {
  private readonly database: DatabaseClient
  private readonly audit: AuditTrail
  private readonly config: PostgresKnowledgeBaseServiceConfig

  constructor(database: DatabaseClient, audit: AuditTrail, config: PostgresKnowledgeBaseServiceConfig) {
    this.database = database
    this.audit = audit
    this.config = config
  }

  async status(userId: string): Promise<KnowledgeStatusView> {
    const level = await knowledgeLevelOf(this.database, userId)
    return { enabled: this.config.client !== null && level !== 'none', level }
  }

  async listDepartments(userId: string): Promise<KnowledgeDepartmentOption[]> {
    return this.myDepartments(userId)
  }

  async list(userId: string): Promise<KnowledgeBaseView[]> {
    const level = await this.requireLevel(userId, 'view')
    const rows = await this.visibleBases(userId)
    if (!rows.length) return []
    const stats = new Map((await this.call(client => client.listKnowledgeBases())).map(item => [item.id, item]))
    const grants = await this.grantsOf(rows.map(row => row.id))
    return rows.map(row => this.view(row, level, grants, stats.get(row.externalId)))
  }

  async get(userId: string, knowledgeBaseId: string): Promise<KnowledgeBaseView> {
    const level = await this.requireLevel(userId, 'view')
    const row = await this.requireVisible(userId, knowledgeBaseId)
    const stats = (await this.call(client => client.listKnowledgeBases())).find(item => item.id === row.externalId)
    return this.view(row, level, await this.grantsOf([row.id]), stats)
  }

  async create(userId: string, input: { name: string; description?: string; ownerDepartmentId: string; includeDescendants?: boolean }) {
    await this.requireLevel(userId, 'bases')
    const name = requireName(input.name)
    const description = (input.description ?? '').trim()
    if (description.length > 200) throw invalidRequest('说明不能超过 200 个字')
    const department = (await this.myDepartments(userId, { excludeRoot: true })).find(item => item.id === input.ownerDepartmentId)
    if (!department) throw invalidRequest('归属部门必须是你所属的部门（不能是根部门）')
    const embeddingModelId = this.config.embeddingModelId
    if (!embeddingModelId) throw dependencyUnavailable('尚未配置统一嵌入模型，暂不能新建知识库，请联系管理员')
    const created = await this.call(client => client.createKnowledgeBase({ name, description, embeddingModelId }))
    const id = `knowledge-base-${randomUUID()}`
    try {
      await this.database.begin(async transaction => {
        await transaction`
          insert into external_knowledge_bases (
            id, tenant_id, connection_id, external_id, name, description, owner_department_id, embedding_model_id, created_by, updated_by
          ) values (
            ${id}, ${tenantId}, ${this.config.connectionId}, ${created.id}, ${name}, ${description}, ${department.id},
            ${embeddingModelId}, ${userId}, ${userId}
          )
        `
        await transaction`
          insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
          values (${`knowledge-grant-${randomUUID()}`}, ${tenantId}, ${id}, ${department.id}, ${input.includeDescendants ?? true}, ${userId}, 'employee')
        `
      })
    } catch (error) {
      // 平台侧没有记录就不要留下孤立的 WeKnora 知识库。
      await this.config.client?.deleteKnowledgeBase(created.id).catch(() => undefined)
      throw error
    }
    await this.record(userId, 'knowledge.base.create', id, `新建知识库“${name}”，可见部门：${department.name}${input.includeDescendants === false ? '' : '（含下级）'}`)
    return this.get(userId, id)
  }

  async update(userId: string, knowledgeBaseId: string, input: { name?: string; description?: string }) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'bases')
    const name = input.name === undefined ? row.name : requireName(input.name)
    const description = input.description === undefined ? row.description : input.description.trim()
    if (description.length > 200) throw invalidRequest('说明不能超过 200 个字')
    await this.call(client => client.updateKnowledgeBase(row.externalId, { name, description }))
    await this.database`
      update external_knowledge_bases set name = ${name}, description = ${description}, updated_by = ${userId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${row.id}
    `
    await this.record(userId, 'knowledge.base.update', row.id, `修改知识库“${row.name}”的名称或说明`)
    return this.get(userId, row.id)
  }

  async remove(userId: string, knowledgeBaseId: string) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'bases')
    try {
      await this.call(client => client.deleteKnowledgeBase(row.externalId))
    } catch (error) {
      // WeKnora 中已不存在时，平台侧照常标为已删除。
      if (!(error instanceof RequestError && error.status === 404)) throw error
    }
    await this.database`
      update external_knowledge_bases set status = 'deleted', updated_by = ${userId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${row.id}
    `
    await this.record(userId, 'knowledge.base.delete', row.id, `删除知识库“${row.name}”`)
  }

  async addGrant(userId: string, knowledgeBaseId: string, input: { departmentId: string; includeDescendants?: boolean }) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'bases')
    // WK11：员工只能授给自己直接所属的部门，且不能是根部门；跨部门由平台管理员在管理端操作。
    const department = (await this.myDepartments(userId, { excludeRoot: true })).find(item => item.id === input.departmentId)
    if (!department) throw accessDenied('只能授给你所属的部门；授给其他部门或全公司请联系平台管理员')
    const inserted = await this.database`
      insert into external_knowledge_base_grants (id, tenant_id, knowledge_base_id, department_id, include_descendants, granted_by, granted_via)
      values (${`knowledge-grant-${randomUUID()}`}, ${tenantId}, ${row.id}, ${department.id}, ${input.includeDescendants ?? true}, ${userId}, 'employee')
      on conflict (tenant_id, knowledge_base_id, department_id) where status = 'active' do nothing
    `
    if (inserted.count) {
      await this.record(userId, 'knowledge.grant.add', row.id, `把知识库“${row.name}”授给${department.name}${input.includeDescendants === false ? '' : '（含下级）'}`)
    }
    return this.get(userId, row.id)
  }

  async revokeGrant(userId: string, knowledgeBaseId: string, grantId: string) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'bases')
    const grants = await this.grantsOf([row.id])
    const grant = grants.find(item => item.id === grantId)
    if (!grant) throw notFound('授权不存在')
    if (grant.grantedVia === 'admin') throw accessDenied('平台管理员授予的可见范围只能由平台管理员撤销')
    if (grants.length <= 1) throw stateConflict('至少保留一个可见部门')
    await this.database`
      update external_knowledge_base_grants set status = 'invalid', invalidated_at = now()
       where tenant_id = ${tenantId} and id = ${grant.id} and status = 'active'
    `
    await this.record(userId, 'knowledge.grant.revoke', row.id, `撤销知识库“${row.name}”对${grant.departmentName}的授权`)
    return this.get(userId, row.id)
  }

  async listDocuments(userId: string, knowledgeBaseId: string, input: { keyword?: string; status?: string; page?: number; pageSize?: number }) {
    await this.requireLevel(userId, 'view')
    const row = await this.requireVisible(userId, knowledgeBaseId)
    const page = input.page ?? 1
    const pageSize = input.pageSize ?? 20
    if (!Number.isInteger(page) || page < 1) throw invalidRequest('page 必须为正整数')
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw invalidRequest('pageSize 必须为 1 到 50 之间的整数')
    const parseStatus = input.status === undefined || input.status === '' || input.status === 'all'
      ? undefined
      : { parsing: 'processing', completed: 'completed', failed: 'failed' }[input.status]
    if (input.status && input.status !== 'all' && !parseStatus) throw invalidRequest('status 必须为 all、parsing、completed 或 failed')
    const keyword = input.keyword?.trim().slice(0, 100) || undefined
    const result = await this.call(client => client.listDocuments(row.externalId, { keyword, parseStatus, page, pageSize }))
    const documents = result.items.filter(item => item.parseStatus !== 'deleting')
    const uploaders = await this.uploaders(documents.map(item => item.id))
    return { items: documents.map(item => toDocumentView(item, uploaders.get(item.id) ?? null)), total: result.total, page, pageSize }
  }

  async uploadDocument(userId: string, knowledgeBaseId: string, input: { fileName: string; mimeType: string; bytes: Buffer }) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'docs')
    const fileName = input.fileName.trim()
    if (!fileName || fileName.length > 200 || /[\\/]/.test(fileName)) throw invalidRequest('文件名无效')
    if (!input.bytes.length) throw invalidRequest('文件为空')
    if (input.bytes.length > maxKnowledgeUploadBytes) throw invalidRequest('文件超过 50 MB 限制')
    const document = await this.call(client => client.uploadDocument(row.externalId, { ...input, fileName }))
    const visible = (await this.grantsOf([row.id])).map(grant => grant.departmentName).join('、')
    await this.record(userId, 'knowledge.document.upload', document.id, `上传“${fileName}”到知识库“${row.name}”，可见部门：${visible}`, 'knowledge_document', row.id)
    return toDocumentView(document, await this.displayName(userId))
  }

  async updateDocument(userId: string, knowledgeBaseId: string, documentId: string, input: { title: string }) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'docs')
    const title = input.title.trim()
    if (!title || title.length > 200) throw invalidRequest('标题长度为 1～200 个字')
    const document = await this.requireDocument(row, documentId)
    await this.call(client => client.updateDocumentTitle(document.id, title))
    await this.record(userId, 'knowledge.document.update', document.id, `修改知识库“${row.name}”中“${document.fileName}”的标题`, 'knowledge_document', row.id)
  }

  async reparseDocument(userId: string, knowledgeBaseId: string, documentId: string) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'docs')
    const document = await this.requireDocument(row, documentId)
    await this.call(client => client.reparseDocument(document.id))
    await this.record(userId, 'knowledge.document.reparse', document.id, `重新解析知识库“${row.name}”中的“${document.fileName}”`, 'knowledge_document', row.id)
  }

  async deleteDocument(userId: string, knowledgeBaseId: string, documentId: string) {
    const row = await this.requireManage(userId, knowledgeBaseId, 'docs')
    const document = await this.requireDocument(row, documentId)
    await this.call(client => client.deleteDocument(document.id))
    await this.record(userId, 'knowledge.document.delete', document.id, `删除知识库“${row.name}”中的“${document.fileName}”`, 'knowledge_document', row.id)
  }

  async downloadDocument(userId: string, knowledgeBaseId: string, documentId: string) {
    await this.requireLevel(userId, 'view')
    const row = await this.requireVisible(userId, knowledgeBaseId)
    const document = await this.requireDocument(row, documentId)
    const file = await this.call(client => client.downloadDocument(document.id))
    await this.record(userId, 'knowledge.document.download', document.id, `下载知识库“${row.name}”中的“${document.fileName}”`, 'knowledge_document', row.id)
    return { fileName: document.fileName || `${document.title || document.id}`, mimeType: 'application/octet-stream', bytes: file.bytes }
  }

  async previewDocument(userId: string, knowledgeBaseId: string, documentId: string) {
    await this.requireLevel(userId, 'view')
    const row = await this.requireVisible(userId, knowledgeBaseId)
    const document = await this.requireDocument(row, documentId)
    const file = await this.call(client => client.previewDocument(document.id))
    // 只返回纯文本：预览内容来自员工上传的文件，不能作为 HTML 在员工端渲染。
    const truncated = file.bytes.length > maxPreviewBytes
    return { text: file.bytes.subarray(0, maxPreviewBytes).toString('utf8'), truncated }
  }

  async sessionKnowledgeBases(userId: string, sessionId: string): Promise<SessionKnowledgeBaseView[]> {
    await this.requirePersonalSession(userId, sessionId)
    return this.selectedBases(userId, sessionId)
  }

  async setSessionKnowledgeBases(userId: string, sessionId: string, knowledgeBaseIds: string[]) {
    await this.requireLevel(userId, 'view')
    await this.requirePersonalSession(userId, sessionId)
    const wanted = [...new Set(knowledgeBaseIds)]
    if (wanted.length > maxSessionKnowledgeBases) throw invalidRequest(`一个对话最多添加 ${maxSessionKnowledgeBases} 个知识库`)
    const current = await this.selectedBases(userId, sessionId)
    const currentIds = new Set(current.map(item => item.id))
    const added = wanted.filter(id => !currentIds.has(id))
    const removed = current.filter(item => !wanted.includes(item.id))
    // 只能添加当前可见的知识库；保留已不可见的旧选择不会让员工重新获得访问。
    const visible = new Set((await this.visibleBases(userId)).map(row => row.id))
    if (added.some(id => !visible.has(id))) throw notFound('知识库不存在或你没有查看权限')
    await this.database.begin(async transaction => {
      if (removed.length) {
        await transaction`
          delete from session_knowledge_bases
           where tenant_id = ${tenantId} and session_id = ${sessionId}
             and knowledge_base_id in ${transaction(removed.map(item => item.id))}
        `
      }
      for (const id of added) {
        await transaction`
          insert into session_knowledge_bases (tenant_id, session_id, knowledge_base_id, added_by, added_at)
          values (${tenantId}, ${sessionId}, ${id}, ${userId}, clock_timestamp())
          on conflict do nothing
        `
      }
    })
    if (added.length || removed.length) {
      await this.record(userId, 'knowledge.session.update', sessionId, `对话中添加 ${added.length} 个、移除 ${removed.length} 个知识库`, 'session')
    }
    return this.selectedBases(userId, sessionId)
  }

  private async requireLevel(userId: string, minimum: KnowledgeLevel): Promise<KnowledgeLevel> {
    if (!this.config.client) throw dependencyUnavailable('企业知识库尚未配置')
    const level = await knowledgeLevelOf(this.database, userId)
    if (levelRank[level] < levelRank[minimum]) {
      throw accessDenied(minimum === 'view' ? '你没有查看企业知识库的权限' : '你没有执行此操作的知识库权限')
    }
    return level
  }

  private async visibleBases(userId: string): Promise<BaseRow[]> {
    return this.database<BaseRow[]>`
      select kb.id, kb.external_id as "externalId", kb.name, kb.description,
             kb.owner_department_id as "ownerDepartmentId", d.name as "ownerDepartmentName",
             exists (
               select 1 from org_department_members m
                 join org_departments md on md.tenant_id = m.tenant_id and md.id = m.department_id and md.status = 'active'
                where m.tenant_id = kb.tenant_id and m.user_id = ${userId} and m.department_id = kb.owner_department_id
             ) as "ownedByMe"
        from external_knowledge_bases kb
        join org_departments d on d.tenant_id = kb.tenant_id and d.id = kb.owner_department_id
       where kb.tenant_id = ${tenantId} and kb.status = 'active' and kb.connection_id = ${this.config.connectionId}
         and kb.id in (${visibleBaseIdsSql(this.database, userId)})
       order by kb.created_at, kb.id
    `
  }

  private async requireVisible(userId: string, knowledgeBaseId: string): Promise<BaseRow> {
    const row = (await this.visibleBases(userId)).find(item => item.id === knowledgeBaseId)
    // 不可见与不存在同样回答，不泄露知识库名称。
    if (!row) throw notFound('知识库不存在或你没有查看权限')
    return row
  }

  /** 管理只对归属部门是本人直接所属部门的知识库生效，不沿部门树继承（5.2）。 */
  private async requireManage(userId: string, knowledgeBaseId: string, minimum: 'docs' | 'bases'): Promise<BaseRow> {
    const level = await this.requireLevel(userId, 'view')
    const row = await this.requireVisible(userId, knowledgeBaseId)
    if (levelRank[level] < levelRank[minimum] || !row.ownedByMe) {
      throw accessDenied(minimum === 'docs' ? '只能管理归属你所在部门的知识库中的文档' : '只能管理归属你所在部门的知识库')
    }
    return row
  }

  private async requireDocument(row: BaseRow, documentId: string): Promise<WeKnoraDocument> {
    let document: WeKnoraDocument
    try {
      document = await this.call(client => client.getDocument(documentId))
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) throw notFound('文档不存在')
      throw error
    }
    // 文档必须属于这个知识库：先向 WeKnora 查询文档所属知识库，再执行操作（第 11 节）。
    if (document.knowledgeBaseId !== row.externalId || document.parseStatus === 'deleting') throw notFound('文档不存在')
    return document
  }

  private async requirePersonalSession(userId: string, sessionId: string) {
    const [session] = await this.database<{ workspaceType: string }[]>`
      select w.workspace_type as "workspaceType"
        from sessions s
        join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
       where s.tenant_id = ${tenantId} and s.id = ${sessionId} and s.created_by = ${userId} and s.status = 'active'
    `
    if (!session) throw notFound('对话不存在')
    if (session.workspaceType !== 'personal') throw invalidRequest('目前只能在个人空间的对话中添加知识库')
  }

  private async selectedBases(userId: string, sessionId: string): Promise<SessionKnowledgeBaseView[]> {
    return this.database<SessionKnowledgeBaseView[]>`
      select kb.id, kb.name,
             (kb.status = 'active' and kb.id in (${visibleBaseIdsSql(this.database, userId)})) as available
        from session_knowledge_bases skb
        join external_knowledge_bases kb on kb.tenant_id = skb.tenant_id and kb.id = skb.knowledge_base_id
       where skb.tenant_id = ${tenantId} and skb.session_id = ${sessionId}
       order by skb.added_at, kb.id
    `
  }

  private async myDepartments(userId: string, options: { excludeRoot?: boolean } = {}): Promise<KnowledgeDepartmentOption[]> {
    const rows = await this.database<(KnowledgeDepartmentOption & { root: boolean })[]>`
      select d.id, d.name, m.is_primary as primary, d.parent_id is null as root
        from org_department_members m
        join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id and d.status = 'active'
        join users u on u.tenant_id = m.tenant_id and u.id = m.user_id and u.status = 'active' and u.identity_provider <> 'ai-hub'
       where m.tenant_id = ${tenantId} and m.user_id = ${userId}
       order by m.is_primary desc, d.path
    `
    return rows.filter(row => !(options.excludeRoot && row.root)).map(({ root: _root, ...row }) => row)
  }

  private async grantsOf(knowledgeBaseIds: string[]): Promise<GrantRow[]> {
    if (!knowledgeBaseIds.length) return []
    return this.database<GrantRow[]>`
      select g.id, g.knowledge_base_id as "knowledgeBaseId", g.department_id as "departmentId",
             case when d.parent_id is null then '全公司' else d.name end as "departmentName",
             g.include_descendants as "includeDescendants", g.granted_via as "grantedVia"
        from external_knowledge_base_grants g
        join org_departments d on d.tenant_id = g.tenant_id and d.id = g.department_id and d.status = 'active'
       where g.tenant_id = ${tenantId} and g.status = 'active' and g.knowledge_base_id in ${this.database(knowledgeBaseIds)}
       order by g.created_at, g.id
    `
  }

  private view(
    row: BaseRow,
    level: KnowledgeLevel,
    grants: GrantRow[],
    stats: { knowledgeCount: number; processingCount: number; updatedAt: string | null } | undefined,
  ): KnowledgeBaseView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerDepartmentId: row.ownerDepartmentId,
      ownerDepartmentName: row.ownerDepartmentName,
      canManageDocuments: row.ownedByMe && levelRank[level] >= levelRank.docs,
      canManageBase: row.ownedByMe && level === 'bases',
      documentCount: stats?.knowledgeCount ?? 0,
      processingCount: stats?.processingCount ?? 0,
      updatedAt: stats?.updatedAt ?? null,
      grants: grants.filter(grant => grant.knowledgeBaseId === row.id).map(({ knowledgeBaseId: _id, ...grant }) => grant),
    }
  }

  /** 上传人：WeKnora 不记录平台员工身份，从平台审计取（第 8 节）。 */
  private async uploaders(documentIds: string[]): Promise<Map<string, string>> {
    if (!documentIds.length) return new Map()
    const rows = await this.database<{ objectId: string; name: string }[]>`
      select distinct on (a.object_id) a.object_id as "objectId", u.display_name as name
        from audit_events a
        join users u on u.tenant_id = a.tenant_id and u.id = a.actor_id
       where a.tenant_id = ${tenantId} and a.action = 'knowledge.document.upload' and a.result = 'success'
         and a.object_id in ${this.database(documentIds)}
       order by a.object_id, a.occurred_at desc
    `
    return new Map(rows.map(row => [row.objectId, row.name]))
  }

  private async displayName(userId: string): Promise<string | null> {
    const [row] = await this.database<{ name: string }[]>`
      select display_name as name from users where tenant_id = ${tenantId} and id = ${userId}
    `
    return row?.name ?? null
  }

  private async record(userId: string, action: string, objectId: string, detail: string, objectType = 'knowledge_base', knowledgeBaseId?: string) {
    await this.audit.appendAudit(
      userId, action, objectId, 'success', `trace-knowledge-${randomUUID()}`,
      knowledgeBaseId ? `${detail}（${knowledgeBaseId}）` : detail, objectType,
    )
  }

  /** 把 WeKnora 的错误翻译成员工能理解的提示，不带 API Key、请求或响应正文。 */
  private async call<T>(operation: (client: WeKnoraClient) => Promise<T>): Promise<T> {
    const client = this.config.client
    if (!client) throw dependencyUnavailable('企业知识库尚未配置')
    try {
      return await operation(client)
    } catch (error) {
      if (error instanceof WeKnoraUnavailableError) throw dependencyUnavailable('知识库服务暂不可用，请稍后重试')
      if (error instanceof WeKnoraRequestError) {
        if (error.status === 409) throw stateConflict('该文档已存在')
        if (error.status === 404) throw notFound('知识库服务中找不到该对象')
        throw invalidRequest('知识库服务拒绝了这个请求')
      }
      throw error
    }
  }
}

function requireName(value: string) {
  const name = value.trim()
  if (!name || name.length > 60) throw invalidRequest('名称长度为 1～60 个字')
  return name
}

function toDocumentStatus(parseStatus: string): KnowledgeDocumentStatus {
  if (parseStatus === 'completed') return 'completed'
  if (parseStatus === 'failed' || parseStatus === 'cancelled') return 'failed'
  return 'parsing'
}

function toDocumentView(document: WeKnoraDocument, uploadedBy: string | null): KnowledgeDocumentView {
  return {
    id: document.id,
    title: document.title || document.fileName,
    fileName: document.fileName,
    fileSize: document.fileSize,
    status: toDocumentStatus(document.parseStatus),
    errorMessage: document.errorMessage,
    uploadedBy,
    updatedAt: document.updatedAt,
  }
}
