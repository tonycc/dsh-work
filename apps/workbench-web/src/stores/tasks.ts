import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, RunStep, TaskRun, TaskSource } from '../types/domain'

const simulationTimers = new Map<string, number[]>()

const completedSources: TaskSource[] = [
  {
    id: 'generated-source-erp',
    type: 'erp',
    title: 'ERP · 业务数据查询结果',
    description: '已按当前用户和工作空间数据范围完成字段过滤。',
    updatedAt: '刚刚',
  },
  {
    id: 'generated-source-mes',
    type: 'mes',
    title: 'MES · 生产执行数据',
    description: '已核对关联工单的计划、开工和完工状态。',
    updatedAt: '刚刚',
  },
]

const completedArtifact: Artifact = {
  id: 'artifact-generated',
  name: '对话分析结果.xlsx',
  type: 'xlsx',
  version: 1,
  size: '196 KB',
  createdAt: '刚刚',
  runId: '',
  workspaceId: 'ws-supply',
  summary: '本轮对话生成的结构化结果、风险项和建议行动。',
}

function nowTime() {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
}

function createQueuedSteps(attemptId: string, attachments: string[]): RunStep[] {
  return [
    {
      id: `${attemptId}-step-1`,
      title: '理解问题与校验权限',
      detail: '等待调度。',
      status: 'pending',
    },
    {
      id: `${attemptId}-step-2`,
      title: '准备所需数据',
      detail: attachments.length > 0 ? `将解析 ${attachments.length} 个上传文件。` : '将查询已授权的数据来源。',
      status: 'pending',
      tool: attachments.length > 0 ? 'document.extract' : 'connector.query',
    },
    {
      id: `${attemptId}-step-3`,
      title: '执行分析',
      detail: '等待数据准备完成。',
      status: 'pending',
    },
    {
      id: `${attemptId}-step-4`,
      title: '组织回答与成果',
      detail: '等待分析完成。',
      status: 'pending',
    },
  ]
}

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
    } finally {
      loading.value = false
    }
  }

  function getTask(id: string) {
    return tasks.value.find((task) => task.id === id)
  }

  function createTask(
    prompt: string,
    attachments: string[],
    workspaceId = 'standalone',
    workspaceName?: string,
  ) {
    const id = `run-${Date.now()}`
    const createdAt = nowTime()
    const steps = createQueuedSteps(id, attachments)
    const task: TaskRun = {
      id,
      title: prompt.length > 28 ? `${prompt.slice(0, 28)}…` : prompt,
      prompt,
      status: 'queued',
      workspaceId,
      workspaceName:
        workspaceName ??
        (workspaceId === 'ws-supply'
          ? '供应链经营分析'
          : workspaceId === 'ws-operations'
            ? '月度经营复盘'
            : '未加入工作空间'),
      sessionId: `session-${Date.now()}`,
      agentVersion: 'dsh-work-assistant@1.2.0',
      createdAt: `今天 ${createdAt}`,
      updatedAt: '刚刚',
      owner: '当前用户',
      messages: [
        {
          id: `${id}-message-user`,
          role: 'user',
          content: prompt,
          createdAt,
        },
      ],
      steps,
      sources: attachments.map((name, index) => ({
        id: `${id}-file-${index}`,
        type: 'file' as const,
        title: name,
        description: '本轮对话上传文件，等待安全检查与解析。',
      })),
      artifacts: [],
      attachments,
    }
    tasks.value.unshift(task)
    startSimulation(id)
    return task
  }

  function sendMessage(id: string, prompt: string, attachments: string[]) {
    const task = getTask(id)
    if (!task) return undefined

    const createdAt = nowTime()
    const attemptId = `${id}-turn-${Date.now()}`
    task.messages.push({
      id: `${attemptId}-message-user`,
      role: 'user',
      content: prompt,
      createdAt,
    })
    task.status = 'queued'
    task.updatedAt = '刚刚'
    task.duration = undefined
    task.summary = undefined
    task.error = undefined
    task.steps = createQueuedSteps(attemptId, attachments)
    task.attachments = [...new Set([...task.attachments, ...attachments])]
    task.sources.push(
      ...attachments
        .filter((name) => !task.sources.some((source) => source.type === 'file' && source.title === name))
        .map((name, index) => ({
          id: `${attemptId}-file-${index}`,
          type: 'file' as const,
          title: name,
          description: '本轮对话上传文件，等待安全检查与解析。',
        })),
    )
    startSimulation(id)
    return task
  }

  function queueTimer(id: string, callback: () => void, delay: number) {
    const timer = window.setTimeout(callback, delay)
    const timers = simulationTimers.get(id) ?? []
    timers.push(timer)
    simulationTimers.set(id, timers)
  }

  function clearSimulation(id: string) {
    simulationTimers.get(id)?.forEach((timer) => window.clearTimeout(timer))
    simulationTimers.delete(id)
  }

  function startSimulation(id: string) {
    clearSimulation(id)
    const task = getTask(id)
    if (!task) return

    const setRunningStep = (index: number, detail: string) => {
      const current = getTask(id)
      if (!current || ['cancelled', 'failed'].includes(current.status)) return
      current.status = 'running'
      current.steps.forEach((step, stepIndex) => {
        if (stepIndex < index) step.status = 'succeeded'
        if (stepIndex === index) {
          step.status = 'running'
          step.detail = detail
        }
      })
      current.updatedAt = '刚刚'
    }

    queueTimer(id, () => setRunningStep(0, '已锁定 Agent Version，并注入当前用户、角色和数据范围。'), 450)
    queueTimer(id, () => setRunningStep(1, '正在调用已授权工具，所有参数均通过规范校验。'), 1400)
    queueTimer(id, () => setRunningStep(2, '正在根据固定业务口径识别异常与优先级。'), 2700)
    queueTimer(id, () => setRunningStep(3, '正在生成页面摘要和可下载成果。'), 4000)
    queueTimer(
      id,
      () => {
        const current = getTask(id)
        if (!current || ['cancelled', 'failed'].includes(current.status)) return
        current.status = 'succeeded'
        current.steps.forEach((step) => {
          step.status = 'succeeded'
          step.duration = step.duration ?? '1.2 秒'
        })
        const nextSources = [
          ...current.sources.map((source) => ({
            ...source,
            description:
              source.type === 'file'
                ? '文件安全检查与结构解析已完成。'
                : source.description,
          })),
          ...completedSources,
        ]
        current.sources = Array.from(new Map(nextSources.map((source) => [source.id, source])).values())
        const artifactId = `${id}-artifact-${current.messages.length}`
        if (!current.artifacts.some((artifact) => artifact.id === artifactId)) {
          current.artifacts.push({
            ...completedArtifact,
            id: artifactId,
            runId: id,
            workspaceId: current.workspaceId,
          })
        }
        current.duration = '5 秒（原型模拟）'
        current.tokenUsage = 6240
        current.summary = '已完成数据核对和风险分析，识别 3 项需要优先关注的事项。'
        current.messages.push({
          id: `${id}-message-assistant`,
          role: 'assistant',
          content:
            '本轮回答已完成。我核对了当前授权范围内的数据，识别出 3 项需要优先关注的风险，并整理了可下载的明细表。建议先处理交付日期最近且没有替代库存的项目。',
          createdAt: nowTime(),
        })
        clearSimulation(id)
      },
      5400,
    )
  }

  function cancelTask(id: string) {
    const task = getTask(id)
    if (!task || !['queued', 'running', 'awaiting_approval'].includes(task.status)) return
    clearSimulation(id)
    task.status = 'cancelled'
    task.updatedAt = '刚刚'
    const runningStep = task.steps.find((step) => step.status === 'running')
    if (runningStep) {
      runningStep.status = 'failed'
      runningStep.detail = '本轮执行已由用户停止。'
    }
  }

  function retryTask(id: string) {
    const task = getTask(id)
    if (!task) return
    task.status = 'queued'
    task.error = undefined
    task.steps.forEach((step) => {
      step.status = 'pending'
      step.detail = '等待调度。'
      step.duration = undefined
    })
    task.messages.push({
      id: `${id}-retry-${Date.now()}`,
      role: 'assistant',
      content: '已创建新的运行尝试，正在重新处理本轮提问。',
      createdAt: nowTime(),
    })
    startSimulation(id)
  }

  function approveTask(id: string) {
    const task = getTask(id)
    if (!task || task.status !== 'awaiting_approval') return
    task.status = 'running'
    const approvalIndex = task.steps.findIndex((step) => step.status === 'awaiting_approval')
    if (approvalIndex >= 0) {
      task.steps[approvalIndex]!.status = 'succeeded'
      task.steps[approvalIndex]!.detail = '已由当前用户确认，仅查询工厂一范围。'
      const nextStep = task.steps[approvalIndex + 1]
      if (nextStep) {
        nextStep.status = 'running'
        nextStep.detail = '正在查询库存并生成缺料分析。'
      }
    }
    task.messages.push({
      id: `${id}-approved-${Date.now()}`,
      role: 'assistant',
      content: '已收到确认。正在按工厂一的数据范围继续查询，不会扩大查询范围。',
      createdAt: nowTime(),
    })
    queueTimer(id, () => {
      const current = getTask(id)
      if (!current || current.status !== 'running') return
      current.status = 'succeeded'
      current.steps.forEach((step) => (step.status = 'succeeded'))
      current.summary = '完成 42 张生产订单的缺料核对，识别 5 张需要关注的订单。'
      current.artifacts = [
        {
          ...completedArtifact,
          id: `${id}-artifact-approved`,
          runId: id,
          workspaceId: current.workspaceId,
          name: '八月生产计划缺料风险清单.xlsx',
        },
      ]
      current.messages.push({
        id: `${id}-approved-result`,
        role: 'assistant',
        content: '分析已完成：42 张生产订单中有 5 张存在缺料风险，明细表已生成。',
        createdAt: nowTime(),
      })
      clearSimulation(id)
    }, 2200)
  }

  return {
    tasks,
    loading,
    initialized,
    activeTasks,
    recentTasks,
    load,
    getTask,
    createTask,
    sendMessage,
    startSimulation,
    cancelTask,
    retryTask,
    approveTask,
  }
})
