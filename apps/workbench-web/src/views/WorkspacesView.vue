<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowRight, Plus, Search, User, UserFilled } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { Workspace } from '@/types/domain'

const contentStore = useContentStore()
const router = useRouter()
const query = ref('')
const createDialogOpen = ref(false)
const newWorkspaceName = ref('')
const newWorkspaceDescription = ref('')
const creating = ref(false)

const filteredWorkspaces = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return [...contentStore.workspaces]
    .filter((workspace) =>
      !keyword || `${workspace.name} ${workspace.description} ${workspace.owner}`.toLowerCase().includes(keyword),
    )
    .sort((left, right) => Number(right.type === 'personal') - Number(left.type === 'personal'))
})

const canCreate = computed(() => Boolean(newWorkspaceName.value.trim()))

function openWorkspace(workspace: Workspace) {
  void router.push(`/workspaces/${workspace.id}`)
}

async function createWorkspace() {
  if (!canCreate.value) return
  creating.value = true
  try {
    const workspace = await contentStore.createTeamWorkspace({
      name: newWorkspaceName.value.trim(),
      description: newWorkspaceDescription.value.trim(),
    })
    ElMessage.success(`已创建团队工作空间“${newWorkspaceName.value.trim()}”`)
    newWorkspaceName.value = ''
    newWorkspaceDescription.value = ''
    createDialogOpen.value = false
    await router.push(`/workspaces/${workspace.id}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建工作空间失败')
  } finally {
    creating.value = false
  }
}

onMounted(() => contentStore.refresh())
</script>

<template>
  <div class="page-container page-container--wide workspace-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">工作空间</h1>
        <p class="page-description">个人空间用于沉淀仅你可见的内容，团队空间用于协作；所有对话、文件和成果始终归属一个工作空间。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="createDialogOpen = true">创建团队工作空间</el-button>
    </header>

    <div class="workspace-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工作空间名称或负责人" />
      <span>{{ filteredWorkspaces.length }} 个可访问工作空间</span>
    </div>

    <div v-if="contentStore.loading" class="workspace-grid">
      <div v-for="index in 3" :key="index" class="workspace-card panel workspace-card--skeleton">
        <el-skeleton :rows="4" animated />
      </div>
    </div>

    <div v-else-if="filteredWorkspaces.length" class="workspace-grid">
      <button
        v-for="workspace in filteredWorkspaces"
        :key="workspace.id"
        class="workspace-card panel"
        :class="{ 'workspace-card--personal': workspace.type === 'personal' }"
        type="button"
        @click="openWorkspace(workspace)"
      >
        <div class="workspace-card__top">
          <span class="workspace-card__icon" :class="{ 'workspace-card__icon--personal': workspace.type === 'personal' }">
            <el-icon><component :is="workspace.type === 'personal' ? User : UserFilled" /></el-icon>
          </span>
          <StatusTag status="neutral" :label="workspace.type === 'personal' ? '个人工作空间' : '团队工作空间'" />
        </div>
        <h2>{{ workspace.name }}</h2>
        <p>{{ workspace.description }}</p>
        <div class="workspace-card__metrics">
          <div><strong>{{ workspace.sessionCount }}</strong><span>对话</span></div>
          <div><strong>{{ workspace.files.length }}</strong><span>文件</span></div>
          <div><strong>{{ workspace.artifactCount }}</strong><span>成果</span></div>
          <div><strong>{{ workspace.memberCount }}</strong><span>{{ workspace.type === 'personal' ? '访问者' : '成员' }}</span></div>
        </div>
        <div class="workspace-card__footer">
          <span v-if="workspace.type === 'personal'">仅你可访问 · {{ workspace.updatedAt }}更新</span>
          <span v-else>负责人 {{ workspace.owner }} · {{ workspace.updatedAt }}更新</span>
          <el-icon><ArrowRight /></el-icon>
        </div>
      </button>
    </div>

    <el-empty v-else description="没有匹配的工作空间">
      <el-button @click="query = ''">清除筛选</el-button>
    </el-empty>

    <el-dialog v-model="createDialogOpen" title="创建团队工作空间" width="min(520px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="工作空间名称" required>
          <el-input v-model="newWorkspaceName" maxlength="40" show-word-limit placeholder="例如：九月交付风险分析" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input
            v-model="newWorkspaceDescription"
            type="textarea"
            :rows="3"
            maxlength="120"
            show-word-limit
            placeholder="说明团队将围绕什么业务主题开展协作"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!canCreate" :loading="creating" @click="createWorkspace">创建工作空间</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.workspace-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 17px;
}

.workspace-toolbar .el-input {
  width: 290px;
}

.workspace-toolbar > span {
  margin-left: auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
}

.workspace-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
}

.workspace-card {
  display: flex;
  min-height: 300px;
  flex-direction: column;
  padding: 20px;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
}

.workspace-card:hover {
  transform: translateY(-2px);
  border-color: #bdcae6;
  box-shadow: 0 12px 32px rgb(30 50 90 / 8%);
}

.workspace-card--skeleton {
  cursor: default;
}

.workspace-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.workspace-card__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 11px;
  color: #315dc4;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.workspace-card__icon--personal {
  color: #147454;
  background: #eaf7f1;
}

.workspace-card h2 {
  margin: 18px 0 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
}

.workspace-card > p {
  min-height: 46px;
  margin: 8px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.65;
}

.workspace-card__metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin-top: 20px;
  padding: 13px 0;
  border-top: 1px solid #eef0f4;
  border-bottom: 1px solid #eef0f4;
}

.workspace-card__metrics div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  border-right: 1px solid #edf0f4;
  text-align: center;
}

.workspace-card__metrics div:last-child {
  border-right: 0;
}

.workspace-card__metrics strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-subheading);
}

.workspace-card__metrics span {
  margin-top: 3px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-micro);
}

.workspace-card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
  padding-top: 17px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

@media (max-width: 1120px) {
  .workspace-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .workspace-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .workspace-toolbar .el-input {
    width: 100%;
  }

  .workspace-toolbar > span {
    margin-left: 0;
  }

  .workspace-grid {
    grid-template-columns: 1fr;
  }
}
</style>
