/** Admin API DTOs. They are intentionally owned by the management application. */
export type AdminRole = 'platform_admin' | 'auditor'

export interface AdminUserProfile {
  id: string
  name: string
  title: string
  department: string
  avatarText: string
  role: AdminRole
  dataScopes: string[]
}

export interface AdminSession {
  user: AdminUserProfile
  identityProvider: 'prototype-sso'
  apiAudience: 'admin'
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface AdminTaskSummary {
  id: string
  status: RunStatus
}

export interface RuntimeDefinition {
  id: string
  name: string
  environment: string
  mode: 'prototype' | 'dsh-worker'
  status: 'healthy' | 'degraded' | 'offline'
  schedulingStatus: 'accepting' | 'draining' | 'disabled'
  version: string
  endpoint: string
  maxConcurrentWorkers: number
  activeWorkers: number
  queuedRuns: number
  attemptTimeoutMinutes: number
  cpuUsage: string
  memoryUsage: string
  latency: string
  lastHeartbeat: string
  checkedAt: string
  healthMessage: string
  capabilities: string[]
}

export interface UpdateRuntimeConfigurationInput {
  runtimeId: string
  maxConcurrentWorkers: number
  attemptTimeoutMinutes: number
  schedulingStatus: RuntimeDefinition['schedulingStatus']
  actor: string
}

export interface SessionDefinition {
  id: string
  title: string
  user: string
  department: string
  workspaceId: string
  workspaceName: string
  agentId: string
  agentName: string
  agentVersion: string
  runtimeId: string
  runId: string
  status: RunStatus
  runCount: number
  messageCount: number
  tokenUsage: number
  createdAt: string
  updatedAt: string
  traceId: string
  dataScopes: string[]
  summary: string
}

export interface ManagedWorkspaceDefinition {
  id: string
  name: string
  description: string
  type: 'team'
  status: 'active' | 'archived'
  ownerDepartment: string
  manager: string
  memberCount: number
  sessionCount: number
  artifactCount: number
  fileCount: number
  members: string[]
  agentNames: string[]
  dataScopes: string[]
  createdAt: string
  updatedAt: string
}

export type PublishStatus = 'draft' | 'published' | 'disabled'

export interface AgentDefinition {
  id: string
  name: string
  description: string
  owner: string
  department: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  status: PublishStatus
  version: string
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  modelPolicy: string
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  updatedAt: string
}

export interface AgentDraftConfiguration {
  id: string
  name: string
  description: string
  owner: string
  department: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
  changeSummary: string
}

export interface CreateAgentDraftInput extends AgentDraftConfiguration {
  actor: string
}

export interface UpdateAgentDraftInput extends Omit<AgentDraftConfiguration, 'id'> {
  agentId: string
  actor: string
}

export interface AgentVersionRecord {
  id: string
  agentId: string
  version: string
  status: PublishStatus
  createdAt: string
  createdBy: string
  publishedAt?: string
  publishedBy?: string
  sourceVersion?: string
  summary: string
  visibility: string
  roleIds: string[]
  dataScopes: string[]
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  modelPolicy: string
  maxTokens: number
  timeoutSeconds: number
  skills: string[]
  tools: string[]
}

export interface AgentReleaseRecord {
  id: string
  agentId: string
  version: string
  action: 'published' | 'enabled' | 'disabled' | 'rollback'
  actor: string
  time: string
  note: string
}

export interface SkillDefinition {
  id: string
  name: string
  version: string
  category: string
  owner: string
  status: PublishStatus
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  updatedAt: string
}

export interface SkillConfiguration {
  id: string
  name: string
  category: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
}

export interface CreateSkillInput extends Omit<SkillConfiguration, 'id'> {
  actor: string
}

export interface UpdateSkillInput extends Omit<SkillConfiguration, 'id'> {
  skillId: string
  actor: string
}

export interface ToolDefinition {
  id: string
  name: string
  system: string
  description: string
  connectorId: string
  risk: 'low' | 'medium' | 'high'
  mode: 'read' | 'write'
  status: 'available' | 'degraded' | 'disabled'
  inputSchema: string
  outputSchema: string
  timeoutSeconds: number
  allowedRoles: string[]
  dataScopes: string[]
  approvalPolicy: 'none' | 'sensitive' | 'always'
  lastCheckedAt: string
}

export interface ConnectorDefinition {
  id: string
  name: string
  system: string
  status: 'healthy' | 'degraded' | 'offline'
  toolCount: number
  protocol: 'rest' | 'openapi' | 'mcp' | 'database'
  endpoint: string
  authType: string
  credentialRef: string
  scopeDescription: string
  latency: string
  lastCheckedAt: string
}

export interface RoleDefinition {
  id: string
  name: string
  userCount: number
  agents: string[]
  tools: string[]
  dataScopes: string[]
  updatedAt: string
}

export interface MemberDefinition {
  id: string
  name: string
  title: string
  department: string
  avatarText: string
  roleIds: string[]
  roleNames: string[]
  status: 'active' | 'suspended'
  ssoStatus: 'synced' | 'pending'
  dataScopes: string[]
  lastActiveAt: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  department: string
  action: string
  object: string
  status: 'success' | 'failed' | 'blocked'
  traceId: string
  detail: string
}

export interface HealthComponent {
  id: string
  name: string
  category: 'application' | 'runtime' | 'dependency'
  status: 'healthy' | 'warning' | 'offline'
  latency: string
  availability: string
  message: string
  checkedAt: string
}

export interface UsagePoint {
  day: string
  runs: number
  tokens: number
}

export interface ModelUsageRecord {
  id: string
  time: string
  runId: string
  agentId: string
  department: string
  provider: string
  model: string
  modelPolicy: string
  dataLevel: 'L0' | 'L1' | 'L2'
  status: 'success' | 'failed' | 'blocked'
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs: number
  costCny: number
  traceId: string
}

export interface PlatformStatus {
  architecture: 'node-modular-monolith'
  persistence: 'prototype-memory'
  sso: 'mock'
  dshRuntime: 'not-connected'
  database: 'not-configured'
  artifactStorage: 'not-configured'
}
