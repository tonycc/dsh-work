import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, WorkbenchAgent, Workspace } from '../types/domain'

export const useContentStore = defineStore('workbench-content', () => {
  const workspaces = ref<Workspace[]>([])
  const artifacts = ref<Artifact[]>([])
  const agents = ref<WorkbenchAgent[]>([])
  const loading = ref(false)
  const initialized = ref(false)
  const personalWorkspace = computed(() => workspaces.value.find(workspace => workspace.type === 'personal'))

  async function load() {
    if (initialized.value) return
    await refresh()
  }

  async function refresh() {
    loading.value = true
    try {
      const [workspaceData, artifactData, agentData] = await Promise.all([
        workbenchApi.getWorkspaces(),
        workbenchApi.getArtifacts(),
        workbenchApi.getAgents(),
      ])
      workspaces.value = workspaceData
      artifacts.value = artifactData
      agents.value = agentData
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  async function createTeamWorkspace(input: {
    name: string
    description: string
    owningTeam: string
    creator: string
  }) {
    void input.owningTeam
    void input.creator
    const workspace = await workbenchApi.createWorkspace({
      name: input.name,
      description: input.description || '团队共享的对话、文件与成果协作空间。',
    })
    workspaces.value.unshift(workspace)
    return workspace
  }

  async function uploadWorkspaceFile(workspaceId: string, file: File) {
    const uploaded = await workbenchApi.uploadWorkspaceFile(workspaceId, file)
    const workspace = workspaces.value.find((item) => item.id === workspaceId)
    if (workspace) workspace.files.unshift(uploaded)
    return uploaded
  }

  async function refreshArtifacts() {
    artifacts.value = await workbenchApi.getArtifacts()
  }

  return {
    workspaces,
    personalWorkspace,
    artifacts,
    agents,
    loading,
    initialized,
    load,
    refresh,
    createTeamWorkspace,
    uploadWorkspaceFile,
    refreshArtifacts,
  }
})
