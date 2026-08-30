import type { Artifact, TaskRun, WorkbenchSession, Workspace } from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'workbench'
    adapter: 'prototype-memory' | 'postgres'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_WORKBENCH_API_BASE_URL ?? '/api/workbench/v1'

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
    throw new Error(`员工工作台接口请求失败（${response.status}）`)
  }

  const payload = (await response.json()) as ApiEnvelope<T>
  return payload.data
}

export const workbenchApi = {
  getSession: () => request<WorkbenchSession>('/session'),
  getTasks: () => request<TaskRun[]>('/tasks'),
  getRun: (runId: string) => request<TaskRun>(`/runs/${encodeURIComponent(runId)}`),
  createSession: (input: { title: string; workspaceId?: string | null }) =>
    request<{ id: string; workspaceId: string | null; agentVersionId: string; title: string; createdAt: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  startRun: (sessionId: string, input: { prompt: string; idempotencyKey: string }) =>
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
  getArtifacts: () => request<Artifact[]>('/artifacts'),
  artifactDownloadUrl: (artifactId: string, version: number) =>
    `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`,
  fileDownloadUrl: (fileId: string) => `${baseUrl}/files/${encodeURIComponent(fileId)}/download`,
}
