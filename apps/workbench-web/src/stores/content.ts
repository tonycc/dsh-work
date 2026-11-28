import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, WorkbenchAgent, WorkbenchSkill, Workspace } from '../types/domain'

export const useContentStore = defineStore('workbench-content', () => {
  const workspaces = ref<Workspace[]>([])
  const artifacts = ref<Artifact[]>([])
  const agents = ref<WorkbenchAgent[]>([])
  const skills = ref<WorkbenchSkill[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  let generation = 0
  function reset() {
    generation++
    workspaces.value = []; artifacts.value = []; agents.value = []; skills.value = []
    loading.value = false; initialized.value = false
  }
  const personalWorkspace = computed(() => workspaces.value.find(workspace => workspace.type === 'personal'))

  async function load() {
    if (initialized.value) return
    await sync()
  }

  /** 最近一轮在途的全量刷新。 */
  let inFlight: { generation: number; promise: Promise<void> } | null = null

  /** 全量刷新：总是发起新一轮请求（写操作后需要服务端最新状态时用）。 */
  function refresh(): Promise<void> {
    const current = generation
    const promise = fetchAll(current).finally(() => {
      if (inFlight?.promise === promise) inFlight = null
    })
    inFlight = { generation: current, promise }
    return promise
  }

  /**
   * 进入页面时的同步：已有一轮在途刷新就复用它。冷启动时空间详情页挂载（子组件
   * onMounted 先于壳层）与壳层 load() 同时发生，合并为一轮请求，不再把三个全量接口各拉两遍。
   */
  function sync(): Promise<void> {
    if (inFlight && inFlight.generation === generation) return inFlight.promise
    return refresh()
  }

  async function fetchAll(current: number) {
    loading.value = true
    try {
      const [workspaceData, artifactData, agentData] = await Promise.all([
        workbenchApi.getWorkspaces(),
        workbenchApi.getArtifacts(),
        workbenchApi.getAgents(),
      ])
      if (current !== generation) return
      workspaces.value = workspaceData
      artifacts.value = artifactData
      agents.value = agentData
      initialized.value = true
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function refreshSkills() {
    const current = generation
    const loaded = await workbenchApi.getSkills()
    if (current === generation) skills.value = loaded
    return current === generation ? loaded : []
  }

  async function refreshAgents() {
    const current = generation
    const loaded = await workbenchApi.getAgents()
    if (current === generation) agents.value = loaded
    return current === generation ? loaded : []
  }

  /** 新建项目空间（群组）：必须带至少一个 Agent 成员，创建与 Agent 加入在服务端同一事务中完成。 */
  async function createTeamWorkspace(input: {
    name: string
    description: string
    agentIds: string[]
    memberUserIds?: string[]
  }) {
    const current = generation
    const workspace = await workbenchApi.createWorkspace({
      name: input.name,
      description: input.description || '团队共享的对话、文件与成果协作空间。',
      agentIds: input.agentIds,
      ...(input.memberUserIds?.length ? { memberUserIds: input.memberUserIds } : {}),
    })
    if (current !== generation) throw new Error('账号已切换，请重新操作')
    workspaces.value.unshift(workspace)
    return workspace
  }

  async function uploadWorkspaceFile(workspaceId: string, file: File) {
    const current = generation
    const uploaded = await workbenchApi.uploadWorkspaceFile(workspaceId, file)
    if (current !== generation) throw new Error('账号已切换，请重新操作')
    const workspace = workspaces.value.find((item) => item.id === workspaceId)
    if (workspace) workspace.files.unshift(uploaded)
    return uploaded
  }

  async function refreshArtifacts() {
    const current = generation
    const loaded = await workbenchApi.getArtifacts()
    if (current === generation) artifacts.value = loaded
  }

  return {
    workspaces,
    reset,
    personalWorkspace,
    artifacts,
    agents,
    skills,
    loading,
    initialized,
    load,
    refresh,
    sync,
    createTeamWorkspace,
    uploadWorkspaceFile,
    refreshArtifacts,
    refreshAgents,
    refreshSkills,
  }
})
