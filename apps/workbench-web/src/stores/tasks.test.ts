import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskRun } from '../types/domain'

const api = vi.hoisted(() => ({
  getTasks: vi.fn(),
  createSession: vi.fn(),
  uploadSessionFile: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  deleteSession: vi.fn(),
  getRun: vi.fn(),
  runEventsUrl: vi.fn((runId: string) => `/events/${runId}`),
}))

vi.mock('../api/client', () => ({ workbenchApi: api }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void)
  }

  close() { this.closed = true }

  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>)
  }
}

const baseTask: TaskRun = {
  id: 'run-001',
  title: '库存分析',
  prompt: '分析库存',
  status: 'running',
  attemptId: 'attempt-001',
  workspaceId: 'ws-supply',
  workspaceName: '供应链经营分析',
  sessionId: 'session-001',
  agentVersion: 'assistant@1.0.0',
  createdAt: '刚刚',
  updatedAt: '刚刚',
  owner: '林岚',
  messages: [],
  steps: [],
  sources: [],
  artifacts: [],
  attachments: [],
}

describe('task store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    api.getTasks.mockResolvedValue([])
    api.deleteSession.mockResolvedValue({ sessionId: 'session-001', title: '库存分析', archived: true })
  })

  it('creates a server Session and Run, then subscribes to persisted events', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.startRun.mockResolvedValue(baseTask)
    const store = useTaskStore()

    const created = await store.createTask('分析库存', [], 'ws-supply')

    expect(api.createSession).toHaveBeenCalledWith({
      title: '分析库存',
      workspaceId: 'ws-supply',
    })
    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
      prompt: '分析库存',
      fileIds: [],
    }))
    expect(created.id).toBe('run-001')
    expect(store.tasks[0]?.id).toBe('run-001')
    expect(FakeEventSource.instances[0]?.url).toBe('/events/run-001')
  })

  it('binds an authorized workspace file id to the immutable Run input', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-001' })
    api.startRun.mockResolvedValue(baseTask)
    const store = useTaskStore()

    await store.createTask('分析共享文件', [], 'ws-supply', '供应链经营分析', undefined, ['file-workspace-001'])

    expect(api.startRun).toHaveBeenCalledWith('session-001', expect.objectContaining({
      fileIds: ['file-workspace-001'],
    }))
  })

  it('lets the server choose the personal workspace when the caller omits a workspace', async () => {
    const { useTaskStore } = await import('./tasks')
    api.createSession.mockResolvedValue({ id: 'session-personal-001', workspaceId: 'ws-personal-U00001' })
    api.startRun.mockResolvedValue({
      ...baseTask,
      sessionId: 'session-personal-001',
      workspaceId: 'ws-personal-U00001',
      workspaceName: '我的空间',
    })
    const store = useTaskStore()

    await store.createTask('整理个人材料', [])

    expect(api.createSession).toHaveBeenCalledWith({ title: '整理个人材料' })
  })

  it('projects permission requests as automatic confirmation without local approval actions', async () => {
    const { useTaskStore } = await import('./tasks')
    const approvalTask = { ...structuredClone(baseTask), id: 'run-approval-001' }
    api.getTasks.mockResolvedValue([approvalTask])
    const store = useTaskStore()
    await store.load()

    FakeEventSource.instances[0]?.emit('approval.required', {
      event_id: 'event-approval-1',
      run_id: 'run-approval-001',
      attempt_id: 'attempt-001',
      sequence: 1,
      event_type: 'approval.required',
      occurred_at: new Date().toISOString(),
      display_message: '请求 read 权限',
      safe_metadata: { tool_name: 'read' },
      trace_id: 'trace-001',
    })
    await Promise.resolve()

    expect(store.tasks[0]?.status).toBe('awaiting_approval')
    expect(store.tasks[0]?.approval).toMatchObject({
      object: '工具 read',
      toolName: 'read',
      dataScope: '供应链经营分析成员授权范围',
    })
    expect(Object.keys(store)).not.toContain('approveTask')
  })

  it('ignores terminal events from an old Attempt after retry and follows the new Attempt', async () => {
    const { useTaskStore } = await import('./tasks')
    const cancelled = { ...structuredClone(baseTask), status: 'cancelled' as const }
    const retrying = {
      ...structuredClone(baseTask),
      status: 'queued' as const,
      attemptId: 'attempt-002',
    }
    const completed = { ...retrying, status: 'succeeded' as const }
    api.getTasks.mockResolvedValue([cancelled])
    api.retryRun.mockResolvedValue(retrying)
    api.getRun.mockResolvedValue(completed)
    const store = useTaskStore()
    await store.load()

    await store.retryTask(baseTask.id)
    const stream = FakeEventSource.instances.at(-1)
    stream?.emit('run.cancelled', {
      event_id: 'event-old-terminal',
      run_id: baseTask.id,
      attempt_id: 'attempt-001',
      sequence: 3,
      event_type: 'run.cancelled',
      occurred_at: new Date().toISOString(),
      display_message: '旧 Attempt 已取消',
      safe_metadata: {},
      trace_id: 'trace-old',
    })
    expect(store.tasks[0]?.status).toBe('queued')

    stream?.emit('run.completed', {
      event_id: 'event-new-terminal',
      run_id: baseTask.id,
      attempt_id: 'attempt-002',
      sequence: 3,
      event_type: 'run.completed',
      occurred_at: new Date().toISOString(),
      display_message: '新 Attempt 已完成',
      safe_metadata: {},
      trace_id: 'trace-new',
    })
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(api.getRun).toHaveBeenCalledWith(baseTask.id)
    expect(store.tasks[0]?.status).toBe('succeeded')
  })

  it('deletes every Run in the archived conversation and closes their event streams', async () => {
    const { useTaskStore } = await import('./tasks')
    const secondRun = { ...structuredClone(baseTask), id: 'run-002', attemptId: 'attempt-002' }
    const otherConversation = {
      ...structuredClone(baseTask),
      id: 'run-003',
      attemptId: 'attempt-003',
      sessionId: 'session-002',
    }
    api.getTasks.mockResolvedValue([structuredClone(baseTask), secondRun, otherConversation])
    const store = useTaskStore()
    await store.load()

    await store.deleteConversation('session-001')

    expect(api.deleteSession).toHaveBeenCalledWith('session-001')
    expect(store.tasks.map(task => task.id)).toEqual(['run-003'])
    expect(FakeEventSource.instances.slice(0, 2).every(stream => stream.closed)).toBe(true)
    expect(FakeEventSource.instances[2]?.closed).toBe(false)
  })
})
