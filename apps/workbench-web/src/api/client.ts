import type { Artifact, TaskRun, WorkbenchAgent, WorkbenchSession, Workspace, WorkspaceFile } from '../types/domain'

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
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw await parseApiError(response, `员工工作台接口请求失败（${response.status}）`)
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

async function requestBlob(path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: 'application/octet-stream' } })
  if (!response.ok) throw await parseApiError(response, `文件下载失败（${response.status}）`)
  return response.blob()
}

async function parseApiError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => undefined) as { error?: ApiErrorPayload } | undefined
  return new WorkbenchApiError(payload?.error ?? {}, response.status, fallback)
}

export const workbenchApi = {
  getSession: () => request<WorkbenchSession>('/session'),
  getTasks: () => request<TaskRun[]>('/tasks'),
  getAgents: () => request<WorkbenchAgent[]>('/agents'),
  getRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}`),
  createSession: (input: { title: string; workspaceId?: string; agentId?: string }) =>
    request<{ id: string; workspaceId: string; agentVersionId: string; title: string; createdAt: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
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
}
