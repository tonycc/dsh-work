/** Workbench API DTOs. They are intentionally owned by the employee application. */
export type UserRole = 'employee' | 'department_manager' | 'platform_admin' | 'auditor'

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
