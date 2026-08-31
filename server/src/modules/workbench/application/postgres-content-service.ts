import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import type { Artifact, Workspace } from '../../../domain/types.ts'
import type { DatabaseClient } from '../../../infrastructure/postgres/database.ts'
import type { FileMount } from '../../runtime/runtime-types.ts'
import { BaselineFileSafetyScanner, type FileSafetyScannerPort } from './file-safety-scanner.ts'
import { extractDocument } from './document-extractor.ts'
import { PostgresWorkspaceService, type WorkspaceType } from './postgres-workspace-service.ts'

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

interface RuntimeFileRow {
  fileId: string
  extractionId: string
  originalName: string
  mimeType: string
  textStorageKey: string
  textSha256: string
}

export interface PreparedRuntimeFile {
  fileId: string
  extractionId: string
  mount: FileMount
}

export class PostgresContentService {
  private readonly database: DatabaseClient
  private readonly storageRoot: string
  private readonly scanner: FileSafetyScannerPort
  private readonly workspaces: PostgresWorkspaceService

  constructor(
    database: DatabaseClient,
    storageRoot: string,
    scanner: FileSafetyScannerPort = new BaselineFileSafetyScanner(),
    workspaces = new PostgresWorkspaceService(database),
  ) {
    this.database = database
    this.storageRoot = resolve(storageRoot)
    this.scanner = scanner
    this.workspaces = workspaces
  }

  async listWorkspaces(actorUserId = userId): Promise<Workspace[]> {
    await this.workspaces.ensurePersonalWorkspace(actorUserId)
    const rows = await this.database<{
      id: string
      name: string
      description: string
      type: WorkspaceType
      owner: string
      memberCount: number
      sessionCount: number
      artifactCount: number
      updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, w.workspace_type as type,
             creator.display_name as owner,
             count(distinct wm.user_id)::integer as "memberCount",
             count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount",
             greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w
        join users creator on creator.tenant_id = w.tenant_id and creator.id = w.created_by
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
       where w.tenant_id = ${tenantId} and w.status = 'active'
         and (
           (w.workspace_type = 'personal' and w.created_by = ${actorUserId})
           or (
             w.workspace_type = 'team'
             and exists (
               select 1 from workspace_members access
                where access.tenant_id = w.tenant_id and access.workspace_id = w.id
                  and access.user_id = ${actorUserId}
             )
           )
         )
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
          join users u on u.tenant_id = f.tenant_id and u.id = ${actorUserId}
         where f.tenant_id = ${tenantId} and f.workspace_id = ${row.id} and f.scan_status = 'clean'
           and f.session_id is null
         order by f.created_at desc
      `
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
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

  async createWorkspace(input: { name: string; description: string }, actorUserId = userId) {
    const id = `ws-${randomUUID()}`
    await this.database.begin(async (transaction) => {
      await transaction`
        insert into workspaces (id, tenant_id, name, description, created_by, status)
        values (${id}, ${tenantId}, ${input.name.trim()}, ${input.description.trim()}, ${actorUserId}, 'active')
      `
      await transaction`
        insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
        values (${tenantId}, ${id}, ${actorUserId}, 'owner', ${actorUserId})
      `
    })
    return (await this.listWorkspaces(actorUserId)).find((workspace) => workspace.id === id)
  }

  async listArtifacts(actorUserId = userId): Promise<Artifact[]> {
    const rows = await this.database<{
      id: string
      name: string
      artifactType: Artifact['type']
      version: number
      sizeBytes: string | number
      createdAt: Date
      runId: string
      workspaceId: string
    }[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt",
             av.source_run_id as "runId", a.workspace_id as "workspaceId"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
       where a.tenant_id = ${tenantId} and s.created_by = ${actorUserId}
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
      workspaceId: row.workspaceId,
      summary: '由 DSH Runtime 本轮回答发布，保留来源 Run 与不可覆盖版本。',
    }))
  }

  async storeWorkspaceFile(workspaceId: string, name: string, mimeType: string, bytes: Buffer, actorUserId = userId) {
    await this.requireWorkspaceAccess(workspaceId, actorUserId)
    return this.storeInputFile({ workspaceId, sessionId: null, name, mimeType, bytes })
  }

  async storeSessionFile(sessionId: string, name: string, mimeType: string, bytes: Buffer, actorUserId = userId) {
    const [session] = await this.database<{ id: string; workspaceId: string }[]>`
      select id, workspace_id as "workspaceId" from sessions
       where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${actorUserId} and status = 'active'
    `
    if (!session) throw new Error('Session 不存在或不可访问')
    return this.storeInputFile({ workspaceId: session.workspaceId, sessionId, name, mimeType, bytes })
  }

  async prepareRuntimeFiles(input: {
    sessionId: string
    fileIds: string[]
    userId: string
  }): Promise<PreparedRuntimeFile[]> {
    const fileIds = [...new Set(input.fileIds.map(id => id.trim()).filter(Boolean))]
    if (fileIds.length > 5) throw new Error('每次 Run 最多分析 5 个文件')
    const prepared: PreparedRuntimeFile[] = []
    let totalBytes = 0
    for (const [index, fileId] of fileIds.entries()) {
      const [row] = await this.database<RuntimeFileRow[]>`
        select f.id as "fileId", fe.id as "extractionId", f.original_name as "originalName",
               f.mime_type as "mimeType", fe.text_storage_key as "textStorageKey",
               fe.text_sha256 as "textSha256"
          from file_objects f
          join file_extractions fe on fe.tenant_id = f.tenant_id and fe.file_id = f.id
          join sessions target on target.tenant_id = f.tenant_id and target.id = ${input.sessionId}
         where f.tenant_id = ${tenantId} and f.id = ${fileId} and f.scan_status = 'clean'
           and fe.status = 'succeeded' and fe.extractor_version = 'm4-basic-v1'
           and target.created_by = ${input.userId} and target.status = 'active'
           and (
             f.session_id = target.id
             or (
               f.workspace_id = target.workspace_id
               and exists (
                 select 1 from workspaces w
                  where w.tenant_id = f.tenant_id and w.id = f.workspace_id and w.status = 'active'
                    and (
                      (w.workspace_type = 'personal' and w.created_by = ${input.userId})
                      or (
                        w.workspace_type = 'team'
                        and exists (
                          select 1 from workspace_members wm
                           where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                             and wm.user_id = ${input.userId}
                        )
                      )
                    )
               )
             )
           )
      `
      if (!row) throw new Error(`文件不存在、不可访问或解析未成功：${fileId}`)
      const content = await readFile(this.resolveStorage(row.textStorageKey), 'utf8')
      totalBytes += Buffer.byteLength(content)
      if (totalBytes > 1024 * 1024) throw new Error('本次 Run 的文件解析文本合计超过 1 MB，请减少或拆分文件')
      const safeName = safeMountName(row.originalName, index)
      prepared.push({
        fileId: row.fileId,
        extractionId: row.extractionId,
        mount: {
          file_id: row.fileId,
          mount_path: `/workspace/input/${safeName}.txt`,
          access: 'read_only',
          source_name: row.originalName,
          media_type: row.mimeType,
          content_sha256: row.textSha256,
          content,
        },
      })
    }
    return prepared
  }

  async getRunInputFileIds(runId: string) {
    const rows = await this.database<{ fileId: string }[]>`
      select rif.file_id as "fileId" from run_input_files rif
      join runs r on r.tenant_id = rif.tenant_id and r.current_attempt_id = rif.attempt_id
       where rif.tenant_id = ${tenantId} and rif.run_id = ${runId}
       order by rif.created_at
    `
    return rows.map(row => row.fileId)
  }

  private async storeInputFile(input: {
    workspaceId: string
    sessionId: string | null
    name: string
    mimeType: string
    bytes: Buffer
  }) {
    const { workspaceId, sessionId, name, mimeType, bytes } = input
    const extension = extname(name).toLowerCase()
    if (!allowedExtensions.has(extension)) throw new Error('仅支持 PDF、DOCX、XLSX、CSV、TXT 和 Markdown 文件')
    if (bytes.length < 1 || bytes.length > 20 * 1024 * 1024) throw new Error('文件大小必须为 1 B～20 MB')
    const scan = await this.scanner.scan({ name, mimeType, bytes })
    if (!scan.clean) throw new Error(`文件安全检查未通过：${scan.reason ?? '未知原因'}`)
    const id = `file-${randomUUID()}`
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storageKey = join(sessionId ? 'session-files' : 'workspace-files', sessionId ?? workspaceId ?? 'unknown', `${id}${extension}`)
    await this.writeStorage(storageKey, bytes)
    await this.database`
      insert into file_objects (
        id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
        size_bytes, sha256, scan_status
      ) values (
        ${id}, ${tenantId}, ${workspaceId}, ${sessionId}, ${storageKey}, ${name}, ${mimeType || 'application/octet-stream'},
        ${bytes.length}, ${sha256}, 'clean'
      )
    `
    const extractionId = `extraction-${randomUUID()}`
    try {
      const extraction = extractDocument(name, bytes)
      const textBytes = Buffer.from(extraction.text, 'utf8')
      const textSha256 = createHash('sha256').update(textBytes).digest('hex')
      const textStorageKey = join('extractions', id, 'm4-basic-v1.txt')
      await this.writeStorage(textStorageKey, textBytes)
      await this.database`
        insert into file_extractions (
          id, tenant_id, file_id, extractor_version, detected_type, status,
          text_storage_key, text_sha256, character_count, page_count, sheet_count, row_count
        ) values (
          ${extractionId}, ${tenantId}, ${id}, 'm4-basic-v1', ${extraction.detectedType}, 'succeeded',
          ${textStorageKey}, ${textSha256}, ${extraction.text.length}, ${extraction.pageCount},
          ${extraction.sheetCount}, ${extraction.rowCount}
        )
      `
      return {
        id,
        name,
        size: formatSize(bytes.length),
        type: extension.slice(1).toUpperCase(),
        uploadedBy: '林岚',
        uploadedAt: '刚刚',
        extractionStatus: 'succeeded' as const,
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error('未知解析错误')
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'FILE_EXTRACTION_FAILED'
      await this.database`
        insert into file_extractions (
          id, tenant_id, file_id, extractor_version, detected_type, status, error_code, error_message
        ) values (
          ${extractionId}, ${tenantId}, ${id}, 'm4-basic-v1', ${detectedType(extension)}, 'failed',
          ${code}, ${error.message.slice(0, 500)}
        )
      `
      throw new Error(`文件解析失败（${code}）：${error.message}`)
    }
  }

  async readFile(fileId: string, actorUserId = userId) {
    const [row] = await this.database<FileRow[]>`
      select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             u.display_name as "uploadedBy"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = ${actorUserId}
       where f.tenant_id = ${tenantId} and f.id = ${fileId} and f.scan_status = 'clean'
         and (
           f.session_id in (select id from sessions where tenant_id = ${tenantId} and created_by = ${actorUserId})
           or f.workspace_id in (
             select w.id from workspaces w
              where w.tenant_id = ${tenantId} and w.status = 'active'
                and (
                  (w.workspace_type = 'personal' and w.created_by = ${actorUserId})
                  or (
                    w.workspace_type = 'team'
                    and exists (
                      select 1 from workspace_members wm
                       where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
                         and wm.user_id = ${actorUserId}
                    )
                  )
                )
           )
         )
    `
    if (!row) throw new Error('文件不存在或不可访问')
    return { name: row.originalName, mimeType: row.mimeType, bytes: await readFile(this.resolveStorage(row.storageKey)) }
  }

  async artifactFileId(artifactId: string, version?: number, actorUserId = userId) {
    const [row] = await this.database<{ fileId: string }[]>`
      select av.file_object_id as "fileId" from artifact_versions av
      join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
      join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
      where av.tenant_id = ${tenantId} and av.artifact_id = ${artifactId} and s.created_by = ${actorUserId}
        and (${version ?? null}::integer is null or av.version_no = ${version ?? null})
      order by av.version_no desc limit 1
    `
    if (!row) throw new Error('Artifact 不存在或不可访问')
    return row.fileId
  }

  private async requireWorkspaceAccess(workspaceId: string, actorUserId: string) {
    await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
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

function detectedType(extension: string): 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text' {
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'docx'
  if (extension === '.xlsx') return 'xlsx'
  if (extension === '.csv') return 'csv'
  return 'text'
}

function safeMountName(name: string, index: number) {
  const stem = name.replace(/\.[^.]+$/, '').replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 50) || 'document'
  return `${String(index + 1).padStart(2, '0')}-${stem}`
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value)
}
