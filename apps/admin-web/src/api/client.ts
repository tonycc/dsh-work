import type {
  AdminSession,
  AdminTaskSummary,
  AgentDefinition,
  CreateAgentDraftInput,
  CreateSkillInput,
  AgentReleaseRecord,
  AgentVersionRecord,
  AuditEvent,
  ConnectorDefinition,
  HealthComponent,
  MemberDefinition,
  ModelUsageRecord,
  ManagedWorkspaceDefinition,
  PlatformStatus,
  RoleDefinition,
  RuntimeDefinition,
  SessionDefinition,
  SkillDefinition,
  ToolDefinition,
  UpdateAgentDraftInput,
  UpdateRuntimeConfigurationInput,
  UpdateSkillInput,
  UsagePoint,
} from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'admin'
    adapter: 'prototype-memory'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_ADMIN_API_BASE_URL ?? '/api/admin/v1'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const fallback = `管理后台接口请求失败（${response.status}）`
    try {
      const payload = (await response.json()) as { error?: { message?: string } }
      throw new Error(payload.error?.message || fallback)
    } catch (cause) {
      if (cause instanceof Error && cause.message !== 'Unexpected end of JSON input') throw cause
      throw new Error(fallback)
    }
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

export const adminApi = {
  getSession: () => request<AdminSession>('/session'),
  getTasks: () => request<AdminTaskSummary[]>('/tasks'),
  getRuntimes: () => request<RuntimeDefinition[]>('/runtimes'),
  checkRuntime: (input: { runtimeId: string; actor: string }) =>
    request<RuntimeDefinition>('/runtimes/check', { method: 'POST', body: JSON.stringify(input) }),
  updateRuntimeConfiguration: (input: UpdateRuntimeConfigurationInput) =>
    request<RuntimeDefinition>('/runtimes/configuration', { method: 'PATCH', body: JSON.stringify(input) }),
  getSessions: () => request<SessionDefinition[]>('/sessions'),
  getWorkspaces: () => request<ManagedWorkspaceDefinition[]>('/workspaces'),
  getAgents: () => request<AgentDefinition[]>('/agents'),
  getAgentVersions: () => request<AgentVersionRecord[]>('/agent-versions'),
  getAgentReleaseRecords: () => request<AgentReleaseRecord[]>('/agent-release-records'),
  createAgentDraft: (input: CreateAgentDraftInput) =>
    request<{ agent: AgentDefinition; version: AgentVersionRecord }>('/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateAgentDraft: (input: UpdateAgentDraftInput) =>
    request<{ agent: AgentDefinition; version: AgentVersionRecord }>('/agents/draft', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  setAgentStatus: (input: { agentId: string; status: 'published' | 'disabled'; actor: string }) =>
    request<{ agent: AgentDefinition; release: AgentReleaseRecord }>('/agents/status', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  rollbackAgent: (input: { agentId: string; version: string; actor: string }) =>
    request<{ agent: AgentDefinition; release: AgentReleaseRecord }>('/agents/rollback', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getSkills: () => request<SkillDefinition[]>('/skills'),
  createSkill: (input: CreateSkillInput) =>
    request<SkillDefinition>('/skills', { method: 'POST', body: JSON.stringify(input) }),
  updateSkill: (input: UpdateSkillInput) =>
    request<SkillDefinition>('/skills', { method: 'PATCH', body: JSON.stringify(input) }),
  setSkillStatus: (input: { skillId: string; status: 'published' | 'disabled'; actor: string }) =>
    request<SkillDefinition>('/skills/status', { method: 'PATCH', body: JSON.stringify(input) }),
  getTools: () => request<ToolDefinition[]>('/tools'),
  setToolStatus: (input: { toolId: string; status: 'available' | 'disabled'; actor: string }) =>
    request<ToolDefinition>('/tools/status', { method: 'PATCH', body: JSON.stringify(input) }),
  getConnectors: () => request<ConnectorDefinition[]>('/connectors'),
  checkConnector: (input: { connectorId: string; actor: string }) =>
    request<ConnectorDefinition>('/connectors/check', { method: 'POST', body: JSON.stringify(input) }),
  getRoles: () => request<RoleDefinition[]>('/roles'),
  getMembers: () => request<MemberDefinition[]>('/members'),
  updateRole: (input: { roleId: string; agents: string[]; tools: string[]; dataScopes: string[] }) =>
    request<RoleDefinition>('/roles', { method: 'PATCH', body: JSON.stringify(input) }),
  updateToolPermissions: (input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) => request<ToolDefinition>('/tools/permissions', { method: 'PATCH', body: JSON.stringify(input) }),
  getAuditEvents: () => request<AuditEvent[]>('/audit-events'),
  getHealth: () => request<HealthComponent[]>('/health'),
  getUsage: () => request<UsagePoint[]>('/usage'),
  getModelUsage: () => request<ModelUsageRecord[]>('/model-usage'),
  getPlatformStatus: () => request<PlatformStatus>('/platform-status'),
}
