import type { Artifact, TaskRun, WorkbenchSession, Workspace } from '../types/domain'

interface ApiEnvelope<T> {
  data: T
  meta: {
    api: 'workbench'
    adapter: 'prototype-memory'
    timestamp: string
  }
}

const baseUrl = import.meta.env.VITE_WORKBENCH_API_BASE_URL ?? '/api/workbench/v1'

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
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
  getWorkspaces: () => request<Workspace[]>('/workspaces'),
  getArtifacts: () => request<Artifact[]>('/artifacts'),
}
