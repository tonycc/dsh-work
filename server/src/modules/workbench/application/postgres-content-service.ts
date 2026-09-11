import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import type { Artifact, Workspace } from '../../../domain/types.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../../infrastructure/postgres/database.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import { authorizationDenied, canReadWorkspaceObject, requestInvalid } from '../../authorization/authorization-errors.ts'
import type { FileMount } from '../../runtime/runtime-types.ts'
import { BaselineFileSafetyScanner, type FileSafetyScannerPort } from './file-safety-scanner.ts'
import { extractDocument } from './document-extractor.ts'
import { PostgresWorkspaceService, type WorkspaceType } from './postgres-workspace-service.ts'

const tenantId = 'tenant-dsh-work'
const allowedExtensions = new Set(['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'])

interface FileRow {
  id: string
  storageKey: string
  originalName: string
  mimeType: string
  sizeBytes: string | number
  createdAt: Date
  uploadedBy: string
  workspaceId: string
}

export interface WorkspaceFileSummary {
  id: string
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  scanStatus: string
  removable: boolean
  canDownload: boolean
}

export interface WorkspaceFilePage {
  items: WorkspaceFileSummary[]
  nextCursor: string | null
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
  private readonly authorization: PostgresAuthorizationService
  private readonly scanner: FileSafetyScannerPort
  private readonly workspaces: PostgresWorkspaceService

  constructor(
    database: DatabaseClient,
    storageRoot: string,
    authorization: PostgresAuthorizationService,
    scanner: FileSafetyScannerPort = new BaselineFileSafetyScanner(),
    workspaces = new PostgresWorkspaceService(database),
  ) {
    this.database = database
    this.storageRoot = resolve(storageRoot)
    this.authorization = authorization
    this.scanner = scanner
    this.workspaces = workspaces
  }

  /**
   * Workspace list for one actor (batch 3 / 3-T2).
   *
   * `status` filters the workspace lifecycle: `all` (the default, matching the
   * confirmed design decision 设计 §2.1/§6「默认全部；个人空间恒显」), `active`,
   * or `archived` (3-T3 归档筛选 — only workspaces the caller may still access,
   * i.e. teams where the caller is still a current member; personal spaces are
   * always active, so they appear under all/active but never under archived).
   *
   * `owner` is the CURRENT owner (`workspace_members.member_role = 'owner'`)
   * rather than the creator, which is a known 1A gap fixed here so a transfer
   * is reflected and 3-T3 can render ownership correctly. `created_by` is kept
   * only as a defensive fallback for anomalous rows.
   */
  async listWorkspaces(
    actorUserId: string,
    options: { status?: 'active' | 'archived' | 'all' } = {},
  ): Promise<Workspace[]> {
    await this.workspaces.ensurePersonalWorkspace(actorUserId)
    // 与 HTTP 层默认保持一致（all）。服务层若仍默认 active，后续新增调用者漏传
    // 就会静默只看活动空间，归档空间不可发现。
    const status = options.status ?? 'all'
    const rows = await this.database<{
      id: string
      name: string
      description: string
      type: WorkspaceType
      status: 'active' | 'archived'
      archivedAt: Date | null
      owner: string
      memberCount: number
      sessionCount: number
      artifactCount: number
      updatedAt: Date
    }[]>`
      select w.id, w.name, w.description, w.workspace_type as type,
             w.status, w.archived_at as "archivedAt",
             coalesce(owner.display_name, creator.display_name) as owner,
             count(distinct wm.user_id)::integer as "memberCount",
             count(distinct s.id)::integer as "sessionCount",
             count(distinct a.id)::integer as "artifactCount",
             greatest(w.created_at, coalesce(max(s.last_active_at), w.created_at)) as "updatedAt"
        from workspaces w
        join users creator on creator.tenant_id = w.tenant_id and creator.id = w.created_by
        left join lateral (
          select ou.display_name
            from workspace_members om
            join users ou on ou.tenant_id = om.tenant_id and ou.id = om.user_id
           where om.tenant_id = w.tenant_id and om.workspace_id = w.id
             and om.member_role = 'owner'
           order by om.joined_at asc, om.user_id asc
           limit 1
        ) owner on true
        left join workspace_members wm on wm.tenant_id = w.tenant_id and wm.workspace_id = w.id
        left join sessions s on s.tenant_id = w.tenant_id and s.workspace_id = w.id
        left join artifacts a on a.tenant_id = w.tenant_id and a.workspace_id = w.id
       where w.tenant_id = ${tenantId}
         and ${status === 'all'
           ? this.database.unsafe(`w.status in ('active', 'archived')`)
           : status === 'archived'
             ? this.database.unsafe(`w.status = 'archived'`)
             : this.database.unsafe(`w.status = 'active'`)}
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
       group by w.id, creator.display_name, owner.display_name
       order by "updatedAt" desc
    `
    return Promise.all(rows.map(async (row) => {
      const members = await this.database<{ name: string }[]>`
        select u.display_name as name from workspace_members wm
        join users u on u.tenant_id = wm.tenant_id and u.id = wm.user_id
        where wm.tenant_id = ${tenantId} and wm.workspace_id = ${row.id}
        order by wm.joined_at asc
      `
      const files = await this.database<Omit<FileRow, 'workspaceId'>[]>`
        select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
               f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
               u.display_name as "uploadedBy"
          from file_objects f
          join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
         where f.tenant_id = ${tenantId} and f.workspace_id = ${row.id} and f.scan_status = 'clean'
           and f.session_id is null
         order by f.created_at desc
      `
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
        status: row.status,
        archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
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

  /**
   * 3-T3 依赖：更新团队空间名称/说明。仅负责人；名称 2–60 字符；说明用 `null`
   * 显式清空（方案 3.3：清空必须显式传 null，不用 undefined 表示清空）。
   * 个人空间不提供该入口（沿用团队专用接口惯例）。
   */
  async updateWorkspace(
    workspaceId: string,
    input: { name?: string; description?: string | null },
    actorUserId: string,
  ) {
    const access = await this.workspaces.resolveReadableWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw requestInvalid('仅支持修改团队工作空间')

    const name = input.name?.trim()
    if (name !== undefined && (name.length < 2 || name.length > 60)) {
      throw requestInvalid('工作空间名称必须为 2 到 60 个字符')
    }
    const rawDescription = input.description
    const description = rawDescription === undefined
      ? undefined
      : (rawDescription === null ? '' : rawDescription.trim())
    // 契约声明 200/403/422：空请求体属请求校验失败，必须显式 422，
    // 否则裸 Error 会被文案分类成 500（符合性评审 F2）。
    if (name === undefined && rawDescription === undefined) {
      throw requestInvalid('没有需要更新的字段')
    }

    await this.runWorkspaceWriteMutation(workspaceId, actorUserId, async (transaction) => {
      if (description !== undefined) {
        await transaction`
          update workspaces set description = ${description}
           where tenant_id = ${tenantId} and id = ${workspaceId}
        `
      }
      if (name !== undefined) {
        await transaction`
          update workspaces set name = ${name}
           where tenant_id = ${tenantId} and id = ${workspaceId}
        `
      }
    })
    const [updated] = (await this.listWorkspaces(actorUserId, { status: 'all' }))
      .filter(workspace => workspace.id === workspaceId)
    if (!updated) throw new Error('工作空间不存在或不可访问')
    return updated
  }

  async createWorkspace(input: { name: string; description: string }, actorUserId: string) {
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
    // 新空间恒为 active，这里显式限定以免受列表默认值变化影响。
    return (await this.listWorkspaces(actorUserId, { status: 'active' })).find((workspace) => workspace.id === id)
  }

  async listArtifacts(actorUserId: string): Promise<Artifact[]> {
    const rows = await this.database<{
      id: string
      name: string
      artifactType: Artifact['type']
      version: number
      sizeBytes: string | number
      createdAt: Date
      runId: string
      workspaceId: string
      workspaceType: string | null
    }[]>`
      select a.id, a.name, a.artifact_type as "artifactType", av.version_no as version,
             f.size_bytes as "sizeBytes", av.created_at as "createdAt",
             av.source_run_id as "runId", a.workspace_id as "workspaceId",
             w.workspace_type as "workspaceType"
        from artifacts a
        join artifact_versions av on av.tenant_id = a.tenant_id and av.artifact_id = a.id
        join file_objects f on f.tenant_id = av.tenant_id and f.id = av.file_object_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
        left join workspaces w on w.tenant_id = a.tenant_id and w.id = a.workspace_id
       where a.tenant_id = ${tenantId} and s.created_by = ${actorUserId}
       order by av.created_at desc
    `
    // 团队成果与团队运行同一读取口径：成果列表同样要复核当前团队读权限，
    // 被移出/退出的成员不能继续看到自己此前在团队空间发布的成果（AC-09）。
    // 3-T1 读取轨：`canReadWorkspaceObject` 对归档空间的现任成员放行（只读保留），
    // 对非成员与不存在空间仍然 fail-closed。个人空间成果直接返回，保持原路径
    // （AC-23）——不在这里再查空间类型，避免每行一次往返（评审实测 200 行 = 200
    // 次多余查询）；团队成果按空间去重后只复核一次，既消掉 N+1 也消掉并发冷启动
    // 的缓存击穿。
    const teamWorkspaceIds = [...new Set(
      rows.filter(row => row.workspaceType === 'team').map(row => row.workspaceId),
    )]
    const readable = new Map<string, boolean>()
    await Promise.all(teamWorkspaceIds.map(async (workspaceId) => {
      readable.set(workspaceId, await canReadWorkspaceObject(this.authorization, workspaceId, actorUserId))
    }))
    const visible = rows.map(row => {
      if (row.workspaceType === 'personal') return row
      // 只有明确的团队空间且在 readable 中被判为可读才保留；类型为 null（空间行缺失）
      // 同样 fail-closed，不因「非团队」而放行（P-B 口径）。
      if (row.workspaceType !== 'team') return null
      return readable.get(row.workspaceId) === true ? row : null
    })
    return visible.filter((row): row is (typeof rows)[number] => row !== null).map((row) => ({
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

  async storeWorkspaceFile(workspaceId: string, name: string, mimeType: string, bytes: Buffer, actorUserId: string) {
    await this.requireWorkspaceAccess(workspaceId, actorUserId)
    return this.storeInputFile({ workspaceId, sessionId: null, name, mimeType, bytes, actorUserId })
  }

  /**
   * Shared workspace files for the current space: name search, keyset paging and
   * server-derived allowed actions (1B-T3 / 设计 §2.3). Removed files leave the
   * referenceable set here; historical runs keep their own references (AC-13).
   */
  async listWorkspaceFiles(input: {
    workspaceId: string
    actorUserId: string
    query?: string
    cursor?: string
    limit?: number
  }): Promise<WorkspaceFilePage> {
    // 3-T1 读取轨：列表属于「只读保留」，归档空间的现任成员仍可读取；上传/移除
    // 仍走 resolveAccessibleWorkspace（执行轨，归档一律拒绝）。
    const access = await this.workspaces.resolveReadableWorkspace(input.workspaceId, input.actorUserId)
    // 读取轨允许归档；但「可移除」是执行轨能力，归档空间一律 false。
    const [workspaceState] = await this.database<{ status: string }[]>`
      select status from workspaces where tenant_id = ${tenantId} and id = ${input.workspaceId}
    `
    const writable = workspaceState?.status === 'active'
    if (access.type === 'personal') throw new Error('仅支持团队工作空间查询共享文件')
    const role = await this.workspaceMemberRole(input.workspaceId, input.actorUserId)
    const canManageAll = role === 'owner' || role === 'admin'
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const cursor = input.cursor ? decodeFileCursor(input.cursor) : null
    const pattern = input.query?.trim()
      ? `%${input.query.trim().replaceAll(/[\\%_]/g, match => `\\${match}`)}%`
      : null

    const rows = await this.database<{
      id: string
      originalName: string
      mimeType: string
      sizeBytes: string | number
      scanStatus: string
      uploadedById: string
      uploadedBy: string
      createdAt: Date
    }[]>`
      select f.id, f.original_name as "originalName", f.mime_type as "mimeType",
             f.size_bytes as "sizeBytes", f.scan_status as "scanStatus",
             f.uploaded_by as "uploadedById", u.display_name as "uploadedBy",
             f.created_at as "createdAt"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where f.tenant_id = ${tenantId} and f.workspace_id = ${input.workspaceId}
         and f.session_id is null and f.removed_at is null
         and f.scan_status <> 'blocked'
         and ${pattern === null ? this.database`true` : this.database`f.original_name ilike ${pattern} escape '\\'`}
         and ${cursor === null
           ? this.database`true`
           : this.database`(f.created_at, f.id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`}
       order by f.created_at desc, f.id desc
       limit ${limit + 1}
    `

    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    const items = page.map(row => ({
      id: row.id,
      name: row.originalName,
      type: extname(row.originalName).slice(1).toUpperCase() || 'FILE',
      size: formatSize(Number(row.sizeBytes)),
      uploadedBy: row.uploadedBy,
      uploadedAt: formatDateTime(row.createdAt),
      scanStatus: row.scanStatus,
      // 权限在服务端判定：负责人/管理员可移除任何文件，成员只能移除自己上传的；
      // 只读成员不能移除（仍可引用与下载）。归档空间属执行轨（3-T1）：移除会被拒，
      // 因此不得回报 removable，否则前端会渲染必然失败的入口（质量评审 P2）。
      removable: writable && (canManageAll || row.uploadedById === input.actorUserId),
      canDownload: row.scanStatus === 'clean',
    }))
    // 游标必须用原始时间戳：uploadedAt 是展示格式，喂回 timestamptz 会解析失败。
    const lastRow = page[page.length - 1]
    return {
      items,
      nextCursor: hasMore && lastRow
        ? encodeFileCursor(lastRow.createdAt.toISOString(), lastRow.id)
        : null,
    }
  }

  /**
   * Logical removal of a shared workspace file (1B-T3): the object, its parsed
   * result and every historical run reference stay intact; only the
   * referenceable listing and future reads lose the file (AC-13).
   */
  async removeWorkspaceFile(workspaceId: string, fileId: string, actorUserId: string): Promise<{ id: string; removed: true }> {
    const access = await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal') throw new Error('仅支持团队工作空间移除共享文件')
    const role = await this.workspaceMemberRole(workspaceId, actorUserId)
    const [file] = await this.database<{ uploadedBy: string; removedAt: Date | null }[]>`
      select uploaded_by as "uploadedBy", removed_at as "removedAt"
        from file_objects
       where tenant_id = ${tenantId} and id = ${fileId} and workspace_id = ${workspaceId}
         and session_id is null
    `
    if (!file) throw new Error('文件不存在或不可访问')
    if (file.removedAt) return { id: fileId, removed: true }
    const canManageAll = role === 'owner' || role === 'admin'
    if (!canManageAll && file.uploadedBy !== actorUserId) {
      throw authorizationDenied('只有负责人、管理员或上传人本人可以移除该文件')
    }
    await this.database`
      update file_objects set removed_at = now(), removed_by = ${actorUserId}
       where tenant_id = ${tenantId} and id = ${fileId} and removed_at is null
    `
    return { id: fileId, removed: true }
  }

  /** Current team role of the actor, or null when not a member. */
  private async workspaceMemberRole(workspaceId: string, actorUserId: string) {
    const [member] = await this.database<{ role: 'owner' | 'admin' | 'member' | 'viewer' }[]>`
      select member_role as role from workspace_members
       where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${actorUserId}
    `
    if (!member) throw authorizationDenied('当前用户不是该空间的成员')
    return member.role
  }

  async storeSessionFile(sessionId: string, name: string, mimeType: string, bytes: Buffer, actorUserId: string) {
    const [session] = await this.database<{ id: string; workspaceId: string }[]>`
      select id, workspace_id as "workspaceId" from sessions
       where tenant_id = ${tenantId} and id = ${sessionId} and created_by = ${actorUserId} and status = 'active'
    `
    if (!session) throw new Error('Session 不存在或不可访问')
    // 上传属执行轨（3-T1）：归档不改 session.status，必须单独校验所属空间仍活跃，
    // 否则归档空间仍可上传会话附件（符合性评审 P1-2，实测返回 201）。
    await this.requireActiveWorkspace(session.workspaceId, actorUserId)
    return this.storeInputFile({ workspaceId: session.workspaceId, sessionId, name, mimeType, bytes, actorUserId })
  }

  /**
   * Execution-track guard for writes that reach a workspace only through a session
   * or file row: personal spaces are the caller's own, team spaces must be active.
   */
  private async requireActiveWorkspace(workspaceId: string, actorUserId: string) {
    const access = await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
    if (access.type === 'personal' && access.id !== `ws-personal-${actorUserId}`) {
      throw authorizationDenied('工作空间不存在或不可访问')
    }
    return access
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
         and f.removed_at is null
           and fe.status = 'succeeded' and fe.extractor_version = 'm4-basic-v1'
           and target.created_by = ${input.userId} and target.status = 'active'
           and (
             f.session_id = target.id
             -- 本人其它会话的附件：作者身份由 target.created_by 与下方 f.session_id 的
             -- 归属共同约束，挂进自己的 Run 不越过任何读取边界（保持既有行为）。
             or f.session_id in (
               select id from sessions own
                where own.tenant_id = ${tenantId} and own.created_by = ${input.userId}
             )
             -- 空间共享文件（session_id 为空）。刻意限定 session_id is null：挂在**他人**
             -- 私有会话下的附件属于「他人私有对话」，空间成员身份不得成为读取依据
             -- （方案 §5/AC-10）——否则可把他人私有附件挂进自己的 Run，交给 DSH 读取，
             -- 绕过 readFile 的同一条限制。
             or (
               f.session_id is null
               and f.workspace_id = target.workspace_id
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
    actorUserId: string
  }) {
    const { workspaceId, sessionId, name, mimeType, bytes, actorUserId } = input
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
        size_bytes, sha256, scan_status, uploaded_by
      ) values (
        ${id}, ${tenantId}, ${workspaceId}, ${sessionId}, ${storageKey}, ${name}, ${mimeType || 'application/octet-stream'},
        ${bytes.length}, ${sha256}, 'clean', ${actorUserId}
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
        uploadedBy: await this.userDisplayName(actorUserId),
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

  async readFile(fileId: string, actorUserId: string) {
    const [row] = await this.database<FileRow[]>`
      select f.id, f.storage_key as "storageKey", f.original_name as "originalName",
             f.mime_type as "mimeType", f.size_bytes as "sizeBytes", f.created_at as "createdAt",
             f.workspace_id as "workspaceId",
             u.display_name as "uploadedBy"
        from file_objects f
        join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
       where f.tenant_id = ${tenantId} and f.id = ${fileId} and f.scan_status = 'clean'
         and f.removed_at is null
         and (
           -- 本人会话的附件（含个人空间与团队空间），作者可读。
           f.session_id in (select id from sessions where tenant_id = ${tenantId} and created_by = ${actorUserId})
           -- 空间共享文件（session_id 为空）。刻意限定 session_id is null：挂在他人
           -- 私有会话下的附件属于「他人私有对话」，空间成员身份不得成为读取依据
           -- （方案 §5「查看他人私有对话与未发布成果：不允许」，AC-10）。
           or (
             f.session_id is null
             and f.workspace_id in (
               select w.id from workspaces w
                -- 3-T1 读取轨：候选空间包含归档，最终是否放行由下方 canReadWorkspaceObject
                -- 按「现任成员」统一判定（归档空间对现任成员只读保留，对非成员与不存在
                -- 空间仍然 fail-closed）。这里若不含 archived，共享文件即使对现任成员
                -- 也会在候选阶段被误判为「不存在」。
                where w.tenant_id = ${tenantId} and w.status in ('active', 'archived')
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
         )
    `
    if (!row) throw new Error('文件不存在或不可访问')
    // 会话作者分支不校验团队身份：被移出/退出的成员仍能命中本人旧会话文件，
    // 必须再按对象所属空间复核当前团队读权限（1B-T4 / AC-09）。3-T1 起该门禁走
    // 读取轨：归档空间的现任成员可读，被移出成员与非成员一律拒绝。拒绝统一走
    // 类型化授权错误，并保持与「不存在」相同文案，避免用 fileId 枚举团队对象。
    if (!(await canReadWorkspaceObject(this.authorization, row.workspaceId, actorUserId))) {
      throw authorizationDenied('文件不存在或不可访问')
    }
    return { name: row.originalName, mimeType: row.mimeType, bytes: await readFile(this.resolveStorage(row.storageKey)) }
  }

  async artifactFileId(artifactId: string, version: number | undefined, actorUserId: string) {
    const [row] = await this.database<{ fileId: string; workspaceId: string }[]>`
      select av.file_object_id as "fileId", a.workspace_id as "workspaceId"
        from artifact_versions av
        join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
        join sessions s on s.tenant_id = a.tenant_id and s.id = a.session_id
       where av.tenant_id = ${tenantId} and av.artifact_id = ${artifactId} and s.created_by = ${actorUserId}
         and (${version ?? null}::integer is null or av.version_no = ${version ?? null})
       order by av.version_no desc limit 1
    `
    if (!row) throw new Error('Artifact 不存在或不可访问')
    // 成果读取与团队运行同一收权口径：作者身份不足以越过当前团队读权限（AC-09）。
    if (!(await canReadWorkspaceObject(this.authorization, row.workspaceId, actorUserId))) {
      throw authorizationDenied('Artifact 不存在或不可访问')
    }
    return row.fileId
  }

  /**
   * 团队空间设置写入：先取空间行锁（与归档/成员变更同一把锁、同一锁序），
   * 再在锁内复核「空间活跃」与「调用者是负责人」。归档在等待锁期间提交时，
   * 这里必须拒绝，避免设置改写穿透只读态。
   */
  private async runWorkspaceWriteMutation(
    workspaceId: string,
    actorUserId: string,
    action: (transaction: DatabaseTransaction) => Promise<void>,
  ) {
    await this.database.begin(async (transaction) => {
      const [workspace] = await transaction<{ status: string }[]>`
        select status from workspaces
         where tenant_id = ${tenantId} and id = ${workspaceId}
         for update
      `
      if (!workspace) throw authorizationDenied('工作空间不存在或不可访问')
      if (workspace.status !== 'active') {
        throw authorizationDenied('工作空间已归档，仅支持有权限的只读查看与下载')
      }
      const [owner] = await transaction<{ role: string }[]>`
        select member_role as role from workspace_members
         where tenant_id = ${tenantId} and workspace_id = ${workspaceId}
           and user_id = ${actorUserId} and member_role = 'owner'
      `
      if (!owner) throw authorizationDenied('仅空间负责人可以修改空间设置')
      await action(transaction)
    })
  }

  private async requireWorkspaceAccess(workspaceId: string, actorUserId: string) {
    await this.workspaces.resolveAccessibleWorkspace(workspaceId, actorUserId)
  }

  private async userDisplayName(userId: string) {
    const [user] = await this.database<{ displayName: string }[]>`
      select display_name as "displayName" from users
       where tenant_id = ${tenantId} and id = ${userId}
    `
    return user?.displayName ?? userId
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

/** Cursor for the (created_at, id) keyset of shared workspace files. */
function encodeFileCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ at: createdAt, id })).toString('base64url')
}

function decodeFileCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') throw new Error('shape')
    return { createdAt: parsed.at, id: parsed.id }
  } catch {
    throw new Error('无效的分页游标')
  }
}
