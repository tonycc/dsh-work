import type {
  AgentCandidatePage,
  AgentMemberPatchAction,
  Artifact,
  MemberCandidatePage,
  TaskRun,
  TeamMemberRole,
  WorkbenchAgent,
  WorkbenchSession,
  WorkbenchSkill,
  Workspace,
  WorkspaceAgentMember,
  WorkspaceFile,
  WorkspaceMember,
  WorkspaceMemberDirectory,
  WorkspaceSessionPage,
  WorkspaceSessionQuery,
} from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'workbench'
    adapter: 'prototype-memory' | 'postgres'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_WORKBENCH_API_BASE_URL ?? '/api/workbench/v1'

interface ApiErrorPayload {
  code?: string
  message?: string
  object?: string
  suggestion?: string
  traceId?: string
}

export class WorkbenchApiError extends Error {
  readonly code: string
  readonly object: string
  readonly suggestion: string
  readonly traceId: string
  readonly status: number

  constructor(payload: ApiErrorPayload, status: number, fallback: string) {
    super(payload.message ?? fallback)
    this.name = 'WorkbenchApiError'
    this.code = payload.code ?? 'request_failed'
    this.object = payload.object ?? '当前操作'
    this.suggestion = payload.suggestion ?? '请稍后重试；若问题持续，请联系管理员。'
    this.traceId = payload.traceId ?? '—'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    const error = await parseApiError(response, `员工工作台接口请求失败（${response.status}）`)
    if (response.status === 401 && path !== '/session') redirectToLogin()
    throw error
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

async function requestBlob(path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    credentials: 'include',
    headers: { Accept: 'application/octet-stream' },
  })
  if (!response.ok) {
    const error = await parseApiError(response, `文件下载失败（${response.status}）`)
    if (response.status === 401) redirectToLogin()
    throw error
  }
  return response.blob()
}

function redirectToLogin() {
  if (typeof window === 'undefined') return
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`
  window.location.assign(`/auth/workbench/login?return_to=${encodeURIComponent(returnTo)}`)
}

async function parseApiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => undefined) as { error?: ApiErrorPayload } | undefined
  return new WorkbenchApiError(payload?.error ?? {}, response.status, fallback)
}

export const workbenchApi = {
  getSession: () => request<WorkbenchSession>('/session'),
  getTasks: () => request<TaskRun[]>('/tasks'),
  getAgents: () => request<WorkbenchAgent[]>('/agents'),
  getSkills: () => request<WorkbenchSkill[]>('/skills'),
  getRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}`),
  createSession: (input: { title: string; workspaceId?: string; agentId?: string; skillId?: string; workspaceAgentMemberId?: string }) =>
    request<{ id: string; workspaceId: string; agentVersionId: string; title: string; createdAt: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteSession: (sessionId: string) => request<{ sessionId: string; title: string; archived: true }>(
    `/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  ),
  startRun: (sessionId: string, input: { prompt: string; idempotencyKey: string; fileIds?: string[] }) =>
    request<TaskRun>(`/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  cancelRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  retryRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }),
  runEventsUrl: (runId: string) => `${baseUrl}/runs/${encodeURIComponent(runId)}/events`,
  getWorkspaces: () => request<Workspace[]>('/workspaces'),
  createWorkspace: (input: { name: string; description: string }) => request<Workspace>('/workspaces', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  uploadWorkspaceFile: async (workspaceId: string, file: File) => request<Workspace['files'][number]>(
    `/workspaces/${encodeURIComponent(workspaceId)}/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
  ),
  uploadSessionFile: async (sessionId: string, file: File) => request<WorkspaceFile>(
    `/sessions/${encodeURIComponent(sessionId)}/files`,
    {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
      },
      body: file,
    },
  ),
  getArtifacts: () => request<Artifact[]>('/artifacts'),
  downloadArtifact: (artifactId: string, version: number) => requestBlob(
    `/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`,
  ),
  artifactDownloadUrl: (artifactId: string, version: number) =>
    `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`,
  fileDownloadUrl: (fileId: string) => `${baseUrl}/files/${encodeURIComponent(fileId)}/download`,
  listMemberCandidates: (workspaceId: string, input: { query?: string; cursor?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<MemberCandidatePage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/member-candidates${suffix}`,
      { method: 'GET' },
    )
  },
  listWorkspaceMembers: (workspaceId: string) =>
    request<WorkspaceMemberDirectory>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'GET',
    }),
  /**
   * 团队历史会话分页（1B-T1）。只在团队分支调用：服务端对个人空间返回 422，
   * 对非成员返回 403（AC-23）。
   *
   * 服务端固定返回本人历史列表（TW-03 的 1B 口径）。
   * 依赖服务端默认值，`team` 只用于「本人无会话」时的一次性空间探测。
   */
  listWorkspaceSessions: (workspaceId: string, input: WorkspaceSessionQuery = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<WorkspaceSessionPage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/sessions${suffix}`,
      { method: 'GET' },
    )
  },
  addWorkspaceMember: (workspaceId: string, input: { userId: string; role: TeamMemberRole }) =>
    request<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMemberRole: (workspaceId: string, userId: string, input: { role: TeamMemberRole }) =>
    request<WorkspaceMember>(`/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  removeWorkspaceMember: (workspaceId: string, userId: string) =>
    request<{ userId: string; removed: true }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    ),
  exitWorkspace: (workspaceId: string) =>
    request<{ workspaceId: string; exited: true }>(`/workspaces/${encodeURIComponent(workspaceId)}/exit`, {
      method: 'POST',
    }),
  transferWorkspaceOwner: (workspaceId: string, input: { toUserId: string }) =>
    request<{ workspaceId: string; previousOwnerId: string; newOwnerId: string }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/owner-transfer`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),
  listWorkspaceAgentCandidates: (workspaceId: string, input: { query?: string; cursor?: string; limit?: number } = {}) => {
    const search = new URLSearchParams()
    if (input.query) search.set('query', input.query)
    if (input.cursor) search.set('cursor', input.cursor)
    if (input.limit !== undefined) search.set('limit', String(input.limit))
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return request<AgentCandidatePage>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-candidates${suffix}`,
      { method: 'GET' },
    )
  },
  listWorkspaceAgentMembers: (workspaceId: string) =>
    request<WorkspaceAgentMember[]>(`/workspaces/${encodeURIComponent(workspaceId)}/agent-members`, {
      method: 'GET',
    }),
  addWorkspaceAgentMember: (workspaceId: string, input: { agentId: string }) =>
    request<WorkspaceAgentMember>(`/workspaces/${encodeURIComponent(workspaceId)}/agent-members`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateWorkspaceAgentMember: (workspaceId: string, id: string, input: { action: AgentMemberPatchAction }) =>
    request<WorkspaceAgentMember>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-members/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    ),
  removeWorkspaceAgentMember: (workspaceId: string, id: string) =>
    request<{ id: string; removed: true }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/agent-members/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
}
