import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { RunStatus, TaskRun } from '../types/domain'

interface RuntimeEvent {
  event_id: string
  run_id: string
  attempt_id: string
  sequence: number
  event_type: string
  occurred_at: string
  display_message: string | null
  safe_metadata: Record<string, unknown>
  trace_id: string
}

const streams = new Map<string, EventSource>()
const runtimeEventTypes = [
  'run.queued', 'run.started', 'assistant.delta', 'assistant.completed',
  'approval.required', 'approval.resolved', 'run.cancel_requested',
  'run.cancelled', 'run.failed', 'run.completed',
]

export const useTaskStore = defineStore('tasks', () => {
  const tasks = ref<TaskRun[]>([])
  const loading = ref(false)
  const initialized = ref(false)

  const activeTasks = computed(() =>
    tasks.value.filter((task) => ['queued', 'running', 'awaiting_approval'].includes(task.status)),
  )
  const recentTasks = computed(() => tasks.value.slice(0, 5))

  async function load() {
    if (initialized.value) return
    loading.value = true
    try {
      tasks.value = await workbenchApi.getTasks()
      initialized.value = true
      for (const task of activeTasks.value) subscribe(task.id)
    } finally {
      loading.value = false
    }
  }

  function getTask(id: string) {
    return tasks.value.find((task) => task.id === id)
  }

  async function createTask(prompt: string, _attachments: string[], workspaceId = 'standalone', _workspaceName?: string) {
    void _attachments
    void _workspaceName
    const session = await workbenchApi.createSession({
      title: prompt,
      workspaceId: workspaceId === 'standalone' ? null : workspaceId,
    })
    const task = await workbenchApi.startRun(session.id, { prompt, idempotencyKey: crypto.randomUUID() })
    upsert(task)
    subscribe(task.id)
    return task
  }

  async function sendMessage(id: string, prompt: string, _attachments: string[]) {
    void _attachments
    const current = getTask(id)
    if (!current) return undefined
    const task = await workbenchApi.startRun(current.sessionId, { prompt, idempotencyKey: crypto.randomUUID() })
    upsert(task)
    subscribe(task.id)
    return task
  }

  async function cancelTask(id: string) {
    const task = await workbenchApi.cancelRun(id)
    upsert(task)
    return task
  }

  async function retryTask(id: string) {
    const task = await workbenchApi.retryRun(id)
    upsert(task)
    subscribe(task.id, true)
    return task
  }

  function approveTask(id: string) {
    const task = getTask(id)
    if (task?.status === 'awaiting_approval') task.status = 'running'
  }

  function subscribe(runId: string, replace = false) {
    if (replace) closeStream(runId)
    if (streams.has(runId)) return
    const stream = new EventSource(workbenchApi.runEventsUrl(runId))
    streams.set(runId, stream)
    for (const eventType of runtimeEventTypes) {
      stream.addEventListener(eventType, (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as RuntimeEvent
        void applyEvent(event)
      })
    }
    stream.onerror = () => {
      if (isTerminal(getTask(runId)?.status)) closeStream(runId)
    }
  }

  async function applyEvent(event: RuntimeEvent) {
    const task = getTask(event.run_id)
    if (!task) return
    if (event.event_type === 'run.queued') task.status = 'queued'
    if (event.event_type === 'run.started') task.status = 'running'
    if (event.event_type === 'approval.required') task.status = 'awaiting_approval'
    if (event.event_type === 'approval.resolved') task.status = 'running'
    if (event.event_type === 'run.cancel_requested') task.status = 'running'
    if (event.event_type === 'run.cancelled') task.status = 'cancelled'
    if (event.event_type === 'run.failed') task.status = 'failed'
    if (event.event_type === 'run.completed') task.status = 'succeeded'
    task.updatedAt = '刚刚'

    if (event.event_type === 'assistant.delta' && event.display_message) {
      const messageId = `${event.attempt_id}-streaming`
      const message = task.messages.find((item) => item.id === messageId)
      if (message) message.content += event.display_message
      else task.messages.push({ id: messageId, role: 'assistant', content: event.display_message, createdAt: '刚刚' })
    }
    if (event.event_type === 'assistant.completed' && event.display_message) {
      const messageId = `${event.attempt_id}-streaming`
      const message = task.messages.find((item) => item.id === messageId)
      if (message) message.content = event.display_message
      else task.messages.push({ id: messageId, role: 'assistant', content: event.display_message, createdAt: '刚刚' })
    }

    if (!['assistant.delta', 'assistant.completed'].includes(event.event_type)) {
      const step = task.steps.find((item) => item.id === event.event_id)
      if (!step) {
        task.steps.push({
          id: event.event_id,
          title: eventTitle(event.event_type),
          detail: event.display_message ?? '执行状态已更新。',
          status: eventStepStatus(event.event_type),
        })
      }
    }

    if (isTerminal(task.status)) {
      await wait(100)
      await refreshRun(task.id)
      closeStream(task.id)
    }
  }

  async function refreshRun(runId: string) {
    const task = await workbenchApi.getRun(runId)
    upsert(task)
    return task
  }

  function upsert(task: TaskRun) {
    const index = tasks.value.findIndex((item) => item.id === task.id)
    if (index >= 0) tasks.value.splice(index, 1, task)
    else tasks.value.unshift(task)
  }

  function closeStream(runId: string) {
    streams.get(runId)?.close()
    streams.delete(runId)
  }

  return {
    tasks, loading, initialized, activeTasks, recentTasks, load, getTask,
    createTask, sendMessage, cancelTask, retryTask, approveTask, refreshRun,
  }
})

function eventTitle(eventType: string) {
  const titles: Record<string, string> = {
    'run.queued': '进入 Runtime 队列',
    'run.started': 'DSH Worker 开始执行',
    'approval.required': '等待权限确认',
    'approval.resolved': '权限确认完成',
    'run.cancel_requested': '正在取消',
    'run.cancelled': '执行已取消',
    'run.failed': '执行失败',
    'run.completed': '执行完成',
  }
  return titles[eventType] ?? '运行事件'
}

function eventStepStatus(eventType: string) {
  if (eventType === 'approval.required') return 'awaiting_approval' as const
  if (['run.failed', 'run.cancelled'].includes(eventType)) return 'failed' as const
  if (eventType === 'run.completed') return 'succeeded' as const
  return 'running' as const
}

function isTerminal(status: RunStatus | undefined) {
  return status !== undefined && ['succeeded', 'failed', 'cancelled'].includes(status)
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}
