import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { RuntimeKnowledgeDocument } from '../runtime/runtime-types.ts'

const tenantId = 'tenant-dsh-work'
const maxContextDocuments = 3
const maxExcerptCharacters = 1200
const minimumRelevanceScore = 4

interface KnowledgeRow {
  id: string
  sourceId: string
  sourceName: string
  title: string
  version: string
  effectiveDate: Date
  content: string
  contentChecksum: string
  keywords: string[]
  dataScope: string
  synthetic: boolean
}

export interface ResolvedKnowledgeDocument extends RuntimeKnowledgeDocument {
  sourceId: string
  sourceName: string
  relevanceScore: number
  synthetic: boolean
}

export class PostgresKnowledgeService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  async resolveContext(input: {
    query: string
    userId: string
    workspaceId: string | null
    dataScopes: string[]
  }): Promise<ResolvedKnowledgeDocument[]> {
    const dataScopes = [...new Set(input.dataScopes)]
    if (dataScopes.length === 0) return []
    const rows = await this.database<KnowledgeRow[]>`
      select kd.id, kd.source_id as "sourceId", ks.name as "sourceName",
             kd.title, kd.version, kd.effective_date as "effectiveDate",
             kd.content, kd.content_checksum as "contentChecksum",
             kd.keywords, kd.data_scope as "dataScope", ks.synthetic
        from knowledge_documents kd
        join knowledge_sources ks on ks.tenant_id = kd.tenant_id and ks.id = kd.source_id
       where kd.tenant_id = ${tenantId} and kd.status = 'published' and ks.status = 'active'
         and kd.data_scope in ${this.database(dataScopes)}
         and exists (
           select 1 from users u where u.tenant_id = kd.tenant_id
             and u.id = ${input.userId} and u.status = 'active'
         )
         and (
           jsonb_array_length(kd.allowed_role_ids) = 0
           or exists (
             select 1 from user_roles ur
              where ur.tenant_id = kd.tenant_id and ur.user_id = ${input.userId}
                and kd.allowed_role_ids ? ur.role_id
                and (ur.valid_until is null or ur.valid_until > now())
           )
         )
         and (
           jsonb_array_length(kd.allowed_workspace_ids) = 0
           or (
             ${input.workspaceId}::text is not null
             and kd.allowed_workspace_ids ? ${input.workspaceId ?? ''}
             and exists (
               select 1 from workspace_members wm
                where wm.tenant_id = kd.tenant_id and wm.workspace_id = ${input.workspaceId ?? ''}
                  and wm.user_id = ${input.userId}
             )
           )
         )
       order by kd.effective_date desc
    `
    const query = input.query.trim().toLowerCase()
    const queryTokens = tokenize(query)
    return rows
      .map(row => ({ row, score: relevanceScore(row, query, queryTokens) }))
      .filter(candidate => candidate.score >= minimumRelevanceScore)
      .sort((left, right) => right.score - left.score || right.row.effectiveDate.getTime() - left.row.effectiveDate.getTime())
      .slice(0, maxContextDocuments)
      .map(({ row, score }) => ({
        documentId: row.id,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        title: row.title,
        version: row.version,
        effectiveDate: formatDate(row.effectiveDate),
        dataScope: row.dataScope,
        contentChecksum: row.contentChecksum,
        excerpt: buildExcerpt(row.content, queryTokens),
        relevanceScore: score,
        synthetic: row.synthetic,
      }))
  }

  async addCitationFooter(attemptId: string, answer: string): Promise<string> {
    const rows = await this.database<{
      title: string
      version: string
      effectiveDate: Date
      synthetic: boolean
    }[]>`
      select kd.title, kd.version, kd.effective_date as "effectiveDate", ks.synthetic
        from run_knowledge_sources rks
        join knowledge_documents kd on kd.tenant_id = rks.tenant_id and kd.id = rks.document_id
        join knowledge_sources ks on ks.tenant_id = kd.tenant_id and ks.id = kd.source_id
       where rks.tenant_id = ${tenantId} and rks.attempt_id = ${attemptId}
       order by rks.relevance_score desc, kd.effective_date desc
    `
    if (!rows.length) return answer
    const citations = rows.map((row, index) =>
      `- 【${index + 1}】${row.title} v${row.version}（生效日期：${formatDate(row.effectiveDate)}${row.synthetic ? '；合成测试数据' : ''}）`,
    )
    return `${answer.trim()}\n\n参考来源\n${citations.join('\n')}`
  }
}

function relevanceScore(row: KnowledgeRow, query: string, tokens: string[]) {
  let score = 0
  const title = row.title.toLowerCase()
  const content = row.content.toLowerCase()
  for (const keyword of row.keywords) {
    if (query.includes(keyword.toLowerCase())) score += 8
  }
  for (const token of tokens) {
    if (title.includes(token)) score += 4
    if (content.includes(token)) score += 1
  }
  return score
}

function tokenize(value: string) {
  const tokens = new Set<string>()
  for (const word of value.match(/[a-z0-9_-]{2,}/g) ?? []) tokens.add(word)
  for (const sequence of value.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    if (sequence.length <= 4) tokens.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) {
      tokens.add(sequence.slice(index, index + 2))
    }
  }
  return [...tokens]
}

function buildExcerpt(content: string, tokens: string[]) {
  const lower = content.toLowerCase()
  const firstMatch = tokens
    .map(token => lower.indexOf(token))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, firstMatch - 160)
  const excerpt = content.slice(start, start + maxExcerptCharacters).trim()
  return `${start > 0 ? '…' : ''}${excerpt}${start + excerpt.length < content.length ? '…' : ''}`
}

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10)
}
