import { ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { Artifact, Workspace } from '../types/domain'

export const useContentStore = defineStore('workbench-content', () => {
  const workspaces = ref<Workspace[]>([])
  const artifacts = ref<Artifact[]>([])
  const loading = ref(false)
  const initialized = ref(false)

  async function load() {
    if (initialized.value) return
    loading.value = true
    try {
      const [workspaceData, artifactData] = await Promise.all([
        workbenchApi.getWorkspaces(),
        workbenchApi.getArtifacts(),
      ])
      workspaces.value = workspaceData
      artifacts.value = artifactData
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  function createTeamWorkspace(input: {
    name: string
    description: string
    owningTeam: string
    creator: string
  }) {
    const workspace: Workspace = {
      id: `ws-${Date.now()}`,
      name: input.name,
      description: input.description || '团队共享的对话、文件与成果协作空间。',
      type: 'team',
      memberCount: 1,
      sessionCount: 0,
      artifactCount: 0,
      updatedAt: '刚刚',
      owner: input.owningTeam,
      members: [input.creator],
      files: [],
    }
    workspaces.value.unshift(workspace)
    return workspace
  }

  return {
    workspaces,
    artifacts,
    loading,
    initialized,
    load,
    createTeamWorkspace,
  }
})
