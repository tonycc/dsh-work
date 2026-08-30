import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import type { Artifact, Workspace } from '../../../domain/types.ts'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import { BaselineFileSafetyScanner, type FileSafetyScannerPort } from './file-safety-scanner.ts'

const tenantId = 'tenant-dsh-work'
const userId = 'U00001'
const allowedExtensions = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'])

interface FileRow {
  id: string
  storageKey: string
  originalName: string
  mimeType: string
  sizeBytes: string | number
  createdAt: Date
  uploadedBy: string
}

export class PostgresContentService {
  private readonly database: DatabaseClient
  private readonly storageRoot: string
  private readonly scanner: FileSafetyScannerPort

  constructor(database: DatabaseClient, storageRoot: string, scanner: FileSafetyScannerPort = new BaselineFileSafetyScanner()) {
    this.database = database
    this.storageRoot = resolve(storageRoot)
    this.scanner = scanner
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const rows = await this.database<{
      id: string
      name: string
      description: string
      owner: string
      memberCount: number
      sessionCount: number
      artifactCount: number
      updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, creator.display_name as owner,
             count(distinct wm.user_id)::integer as "memberCount",
             count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount",
             greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w
        join workspace_members access
          on access.tenant_id = w.tenant_id and access.workspace_id = w.id and access.user_id = ${userId}
        join users creator on creator.tenant_id = w.tenant_id and creator.id = w.created_by
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
       where w.tenant_id = ${tenantId} and w.status = 'active'
       group by w.id, creator.display_name
       order by "updatedAt" desc
    `
    return Promise.all(rows.map(async (row) => {
      const members = await this.database<{ name: string }[]>`
        select u.display_name as name from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
        where wm.tenant_id = ${tenantId} and wm.workspace_id = ${row.id}
        order by wm.joined_at asc
      `
      const files = await this.database<FileRow[]>`
        select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
               f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
               u.display_name as "uploadedBy"
          from file_objects f
          join users u on u.tenant_id = f.tenant_id and u.id = ${userId}
         where f.tenant_id = ${tenantId} and f.workspace_id = ${row.id} and f.scan_status = 'clean'
           and f.session_id is null
         order by f.created_at desc
      `
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        type: 'team' as const,
        memberCount: row.memberCount,
        sessionCount: row.sessionCount,
        artifactCount: row.artifactCount,
        updatedAt: formatDateTime(row.updatedAt),
        owner: row.owner,
        members: members.map((member) => member.name),
        files: files.map((file) => ({
          id: file.id,
          name: file.originalName,
          type: extname(file.originalName).slice(1).toUpperCase() || 'FILE',
          size: formatSize(Number(file.sizeBytes)),
          uploadedBy: file.uploadedBy,
          uploadedAt: formatDateTime(file.createdAt),
        })),
      }
    }))
  }

  async createWorkspace(input: { name: string; description: string }) {
    const id = `ws-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into workspaces (id, tenant_id, name, description, created_by, status)
        values (${id}, ${tenantId}, ${input.name.trim()}, ${input.description.trim()}, ${userId}, 'active')
      `
      await transaction`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${id}, ${userId}, 'owner', ${userId})
      `
    })
    return (await this.listWorkspaces()).find((workspace) => workspace.id === id)
  }

  async listArtifacts(): Promise<Artifact[]> {
    const rows = await this.database<{
      id: string
      name: string
      artifactType: Artifact['type']
      version: number
      sizeBytes: string | number
      createdAt: Date
      runId: string
      workspaceId: string | null
    }[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt",
             av.source_run_id as "runId", a.workspace_id as "workspaceId"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
       where a.tenant_id = ${tenantId} and s.created_by = ${userId}
       order by av.created_at desc
    `
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.artifactType,
      version: row.version,
      size: formatSize(Number(row.sizeBytes)),
      createdAt: formatDateTime(row.createdAt),
      runId: row.runId,
      workspaceId: row.workspaceId ?? 'standalone',
      summary: '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
    }))
  }

  async storeWorkspaceFile(workspaceId: string, name: string, mimeType: string, bytes: Buffer) {
    await this.requireWorkspaceAccess(workspaceId)
    const extension = extname(name).toLowerCase()
    if (!allowedExtensions.has(extension)) throw new Error('仅支持 PDF、DOCX、XLSX、CSV、TXT 和 Markdown 文件')
    if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) throw new Error('文件大小必须为 1 B～20 MB')
    const scan = await this.scanner.scan({ name, mimeType, bytes })
    if (!scan.clean) throw new Error(`文件安全检查未通过：${scan.reason ?? '未知原因'}`)
    const id = `file-${randomUUID()}`
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storageKey = join('workspace-files', workspaceId, `${id}${extension}`)
    await this.writeStorage(storageKey, bytes)
    await this.database`
      insert into file_objects (
        id, tenant_id, workspace_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status
      ) values (
        ${id}, ${tenantId}, ${workspaceId}, ${storageKey}, ${name}, ${mimeType || 'application/octet-stream'},
        ${bytes.length}, ${sha256}, 'clean'
      )
    `
    return { id, name, size: formatSize(bytes.length), type: extension.slice(1).toUpperCase(), uploadedBy: '林岚', uploadedAt: '刚刚' }
  }

  async publishAssistantResult(input: {
    runId: string
    attemptId: string
    sessionId: string
    workspaceId: string | null
    content: string
  }) {
    const fileId = `file-result-${input.attemptId}`
    const artifactId = `artifact-${input.runId}`
    const bytes = Buffer.from(`# dsh-work 对话成果\n\n${input.content}\n`, 'utf8')
    const storageKey = join('artifacts', input.runId, `${input.attemptId}.md`)
    await this.writeStorage(storageKey, bytes)
    const [attempt] = await this.database<{ attemptNo: number }[]>`
      select attempt_no as "attemptNo" from run_attempts
       where tenant_id = ${tenantId} and id = ${input.attemptId}
    `
    const [session] = await this.database<{ title: string }[]>`
      select title from sessions where tenant_id = ${tenantId} and id = ${input.sessionId}
    `
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into file_objects (
          id, tenant_id, workspace_id, session_id, storage_key, original_name,
          mime_type, size_bytes, sha256, scan_status
        ) values (
          ${fileId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${storageKey},
          ${`${session?.title ?? '对话成果'}.md`}, 'text/markdown', ${bytes.length},
          ${createHash('sha256').update(bytes).digest('hex')}, 'clean'
        ) on conflict (id) do nothing
      `
      await transaction`
        insert into artifacts (
          id, tenant_id, workspace_id, session_id, name, artifact_type, created_by
        ) values (
          ${artifactId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId},
          ${`${session?.title ?? '对话成果'}.md`}, 'markdown', ${userId}
        ) on conflict (id) do nothing
      `
      await transaction`
        insert into artifact_versions (
          id, tenant_id, artifact_id, version_no, file_object_id, source_run_id
        ) values (
          ${`artifact-version-${input.attemptId}`}, ${tenantId}, ${artifactId}, ${attempt?.attemptNo ?? 1},
          ${fileId}, ${input.runId}
        ) on conflict (tenant_id, artifact_id, version_no) do nothing
      `
    })
  }

  async readFile(fileId: string) {
    const [row] = await this.database<FileRow[]>`
      select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             u.display_name as "uploadedBy"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = ${userId}
       where f.tenant_id = ${tenantId} and f.id = ${fileId} and f.scan_status = 'clean'
         and (
           f.session_id in (select id from sessions where tenant_id = ${tenantId} and created_by = ${userId})
           or f.workspace_id in (select workspace_id from workspace_members where tenant_id = ${tenantId} and user_id = ${userId})
         )
    `
    if (!row) throw new Error('文件不存在或不可访问')
    return { name: row.originalName, mimeType: row.mimeType, bytes: await readFile(this.resolveStorage(row.storageKey)) }
  }

  async artifactFileId(artifactId: string, version?: number) {
    const [row] = await this.database<{ fileId: string }[]>`
      select av.file_object_id as "fileId" from artifact_versions av
      join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
      join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
      where av.tenant_id = ${tenantId} and av.artifact_id = ${artifactId} and s.created_by = ${userId}
        and (${version ?? null}::integer is null or av.version_no = ${version ?? null})
      order by av.version_no desc limit 1
    `
    if (!row) throw new Error('Artifact 不存在或不可访问')
    return row.fileId
  }

  private async requireWorkspaceAccess(workspaceId: string) {
    const [row] = await this.database<{ allowed: boolean }[]>`
      select true as allowed from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${userId}
    `
    if (!row?.allowed) throw new Error('工作空间不存在或不可访问')
  }

  private async writeStorage(storageKey: string, bytes: Buffer) {
    const target = this.resolveStorage(storageKey)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  }

  private resolveStorage(storageKey: string) {
    const target = resolve(this.storageRoot, storageKey)
    if (!target.startsWith(`${this.storageRoot}/`)) throw new Error('非法存储路径')
    return target
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}
