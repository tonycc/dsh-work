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
   * 团队空间归档状态（design §2.5 归档态）。服务端当前 `/workspaces` 契约
   * 尚未返回该字段，前端只在收到 `archived` 时渲染归档态。
   */
  status?: 'active' | 'archived'
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
