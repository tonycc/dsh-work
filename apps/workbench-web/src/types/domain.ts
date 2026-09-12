/** Workbench API DTOs. They are intentionally owned by the employee application. */
export type UserRole = 'employee' | 'department_manager' | 'business_admin' | 'platform_admin' | 'auditor'

export interface UserProfile {
  id: string
  name: string
  title: string
  department: string
  avatarText: string
  role: UserRole
  dataScopes: string[]
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_approval'

export interface RunStep {
  id: string
  title: string
  detail: string
  status: StepStatus
  tool?: string
  duration?: string
}

export interface TaskSource {
  id: string
  type: 'knowledge' | 'erp' | 'mes' | 'file'
  title: string
  description: string
  version?: string
  effectiveAt?: string
  dataScope?: string
  synthetic?: boolean
  updatedAt?: string
}

export interface Artifact {
  id: string
  name: string
  type: 'xlsx' | 'docx' | 'pdf' | 'markdown'
  version: number
  size: string
  createdAt: string
  runId: string
  workspaceId: string
  summary: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface TaskRun {
  id: string
  attemptId: string | null
  title: string
  prompt: string
  status: RunStatus
  workspaceId: string
  workspaceName: string
  sessionId: string
  agentVersion: string
  createdAt: string
  updatedAt: string
  duration?: string
  tokenUsage?: number
  owner: string
  messages: ChatMessage[]
  steps: RunStep[]
  sources: TaskSource[]
  artifacts: Artifact[]
  attachments: string[]
  skill?: Pick<WorkbenchSkill, 'id' | 'name' | 'version'>
  summary?: string
  approval?: {
    object: string
    reason: string
    nextStep: string
    toolName: string
    dataScope: string
  }
  error?: {
    code: string
    message: string
    object: string
    reason: string
    suggestion: string
    retryable: boolean
  }
}

export interface WorkspaceFile {
  id: string
  name: string
  type: string
  size: string
  uploadedBy: string
  uploadedAt: string
  extractionStatus?: 'succeeded' | 'failed'
  /**
   * 逻辑文件 id（TW-07 起团队共享文件按逻辑文件聚合返回）。团队动态的
   * `objectId` 是逻辑文件 id，前端据此从已加载文件列表解析名称，不把它当名称显示。
   */
  logicalFileId?: string
}

export interface Workspace {
  id: string
  name: string
  description: string
  type: 'personal' | 'team'
  memberCount: number
  sessionCount: number
  artifactCount: number
  updatedAt: string
  owner: string
  members: string[]
  files: WorkspaceFile[]
  /**
   * 团队空间归档状态（design §2.1/§2.5 归档态）。3-T2 起服务端 `/workspaces`
   * 恒返回该字段（个人空间恒为 `active`），前端据此渲染归档只读态；不再可选，
   * 缺省即视为契约破损而不是活动空间。
   */
  status: WorkspaceStatus
  /** 归档时间；活动空间为 `null`。 */
  archivedAt: string | null
}

export type WorkspaceStatus = 'active' | 'archived'

/** `GET /workspaces?status=` 的筛选口径（design §2.1 / §6：默认全部，个人空间恒显）。 */
export type WorkspaceStatusFilter = 'active' | 'archived' | 'all'

/** 归档/恢复接口返回的最小状态（`POST /workspaces/:id/archive|restore`）。 */
export interface WorkspaceLifecycleResult {
  id: string
  status: WorkspaceStatus
  archivedAt: string | null
}

/** `PATCH /workspaces/:id` 的入参；`description: null` 显式清空说明（方案 3.3）。 */
export interface WorkspaceUpdateInput {
  name?: string
  description?: string | null
}

/**
 * 团队动态 kind 的闭合集合（迁移 0026 CHECK 约束，TW-08 / 3-T7 契约）。
 * 服务端不返回任何名称字段：动态文案由 kind + safeMetadata + 演员名生成。
 */
export type WorkspaceActivityKind =
  | 'member_added'
  | 'member_removed'
  | 'member_exit'
  | 'role_changed'
  | 'owner_transferred'
  | 'agent_member_added'
  | 'agent_member_removed'
  | 'file_uploaded'
  | 'file_removed'
  | 'file_version_added'
  | 'workspace_archived'
  | 'workspace_restored'

export type WorkspaceActivityObjectType = 'member' | 'agent_member' | 'file' | 'workspace'

/**
 * 一条团队动态。`objectId` 只是安全对象引用（成员／Agent／逻辑文件／空间 id），
 * 读取时由调用方按当前读取轨重新解析；它绝不是可展示的名称。
 */
export interface WorkspaceActivityItem {
  id: string
  kind: WorkspaceActivityKind
  actorUserId: string
  actorDisplayName: string
  objectType: WorkspaceActivityObjectType
  objectId: string
  /** safeMetadata：仅含 id／角色／版本号白名单，不含名称与正文。 */
  safeMetadata: Record<string, unknown>
  occurredAt: string
}

export interface WorkspaceActivityPage {
  workspaceId: string
  items: WorkspaceActivityItem[]
  /** null 表示已到末尾。 */
  nextCursor: string | null
}

/** 动态与通知分页参数；`limit` 服务端限定 1..100。 */
export interface WorkspaceActivityQuery {
  cursor?: string
  limit?: number
}

/** 未读／静音状态（`POST …/notifications/read|mute|unmute` 的最小返回）。 */
export interface WorkspaceNotificationState {
  workspaceId: string
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  /** `last_read_at` 之后的动态条数；静音时为 0。 */
  unreadCount: number
}

/**
 * 未读通知分页：与服务端「未读」口径一致（`items` 是未读条目），并附带调用者
 * 本人的静音与已读位置。静音不影响动态 feed。
 */
export interface WorkspaceNotificationView extends WorkspaceActivityPage {
  muted: boolean
  mutedAt: string | null
  lastReadAt: string | null
  unreadCount: number
}

/** 团队空间员工角色：负责人、管理员、成员、只读成员。 */
export type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/** 成员选择所需的最小员工字段；不暴露管理端全量身份数据。 */
export interface MemberCandidate {
  id: string
  displayName: string
  department: string
}

export interface MemberCandidatePage {
  items: MemberCandidate[]
  nextCursor: string | null
}

export interface WorkspaceMember {
  userId: string
  displayName: string
  role: TeamMemberRole
  joinedAt: string
}

/**
 * 团队员工成员名册 + 调用者自己的角色。服务端返回调用者角色，使员工端按服务端
 * 状态渲染允许动作：负责人转交后创建者不再是负责人，不能按创建者推断权限。
 */
export interface WorkspaceMemberDirectory {
  items: WorkspaceMember[]
  currentUserRole: TeamMemberRole | null
}

/**
 * 团队历史会话摘要（1B-T1，design §2.2）：一条对应一个稳定 Session，只带最新
 * Run 指针与状态，不携带对话正文。个人空间不会请求该数据（AC-23）。
 */
export interface WorkspaceSessionSummary {
  sessionId: string
  title: string
  creatorId: string
  creatorName: string
  /** ISO 时间；列表固定按该字段倒序（服务端排序，前端不重排）。 */
  lastActiveAt: string
  runCount: number
  latestRun: { id: string; status: RunStatus } | null
}

export interface WorkspaceSessionPage {
  items: WorkspaceSessionSummary[]
  /** null 表示已到末尾。 */
  nextCursor: string | null
}

/**
 * 团队历史会话查询参数；`limit` 服务端限定 1..100。
 *
 * 范围固定为调用者本人发起的会话：服务端按 `created_by` 强制过滤，没有范围参数
 * （原 `scope=mine/team` 已随 2A／2B 放弃一并移除）。
 */
export interface WorkspaceSessionQuery {
  query?: string
  cursor?: string
  limit?: number
}

/** Agent 成员候选的最小字段；不暴露模型、凭据与 Skill/Tool 配置明细。 */
export interface AgentCandidate {
  agentId: string
  name: string
  description: string
  activeVersionId: string
  activeVersion: string
  status: 'published'
  /**
   * 加入确认区展示项（design §2.6）。当前 T4 契约只返回职责与版本，这三项
   * 为可选：服务端补齐前前端显示「详情待平台补充」，不伪造内容。
   */
  skillNames?: string[]
  toolNames?: string[]
  dataScope?: string
}

export interface AgentCandidatePage {
  items: AgentCandidate[]
  nextCursor: string | null
}

/** Agent 成员状态：可用、已停用；移出不出现在列表中。 */
export type AgentMemberStatus = 'available' | 'disabled'

/** 当前操作人允许的动作；Agent 成员不套用员工角色语义。 */
export type AgentMemberAction = 'start_conversation' | 'disable' | 'enable' | 'upgrade' | 'remove'

export type AgentMemberPatchAction = 'disable' | 'enable' | 'upgrade'

export interface WorkspaceAgentMember {
  id: string
  agentId: string
  name: string
  description: string
  status: AgentMemberStatus
  version: string
  addedBy: string
  createdAt: string
  allowedActions: AgentMemberAction[]
  /**
   * 状态为不可用时的具体原因（平台未授权／版本失效／Runtime 不可用，design
   * §2.6）。T4 契约目前不返回该字段，前端只在服务端给出时展示 tooltip。
   */
  unavailableReason?: string
}

export interface WorkbenchSession {
  user: UserProfile
  identityProvider: 'prototype-sso' | 'ai-hub-oidc'
  apiAudience: 'workbench'
}

export interface WorkbenchAgent {
  id: string
  name: string
  description: string
  welcomeMessage: string
  version: string
  examplePrompts: string[]
}

export interface WorkbenchSkill {
  id: string
  name: string
  version: string
  category: string
  description: string
  owner: string
  testPrompt: string
  updatedAt: string
}
