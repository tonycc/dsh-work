<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FolderOpened, Search, View } from '@element-plus/icons-vue'

import { useContentStore } from '@/stores/content'
import type { ManagedWorkspaceDefinition } from '@/types/domain'

const contentStore = useContentStore()
const query = ref('')
const selectedWorkspace = ref<ManagedWorkspaceDefinition>()
const drawerOpen = ref(false)

const filteredWorkspaces = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.workspaces.filter((workspace) =>
    !keyword || `${workspace.name} ${workspace.id} ${workspace.description} ${workspace.creator}`.toLowerCase().includes(keyword),
  )
})
const memberTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.memberCount, 0))
const sessionTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.sessionCount, 0))
const artifactTotal = computed(() => contentStore.workspaces.reduce((sum, workspace) => sum + workspace.artifactCount, 0))

function inspect(workspace: ManagedWorkspaceDefinition) {
  selectedWorkspace.value = workspace
  drawerOpen.value = true
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page workspace-admin-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工作空间、标识或创建人" />
        <span class="filter-bar__meta">{{ filteredWorkspaces.length }} 个团队工作空间</span>
      </div>
    </section>

    <section v-loading="contentStore.loading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">团队工作空间</div><div class="metric-value">{{ contentStore.workspaces.length }}</div><div class="metric-detail">个人空间由系统自动维护</div></article>
      <article class="metric-card"><div class="metric-label">成员席位</div><div class="metric-value">{{ memberTotal }}</div><div class="metric-detail">按工作空间成员关系累计</div></article>
      <article class="metric-card"><div class="metric-label">空间内 Session</div><div class="metric-value">{{ sessionTotal }}</div><div class="metric-detail">继承工作空间上下文</div></article>
      <article class="metric-card"><div class="metric-label">空间成果</div><div class="metric-value">{{ artifactTotal }}</div><div class="metric-detail">团队可复用交付物</div></article>
    </section>

    <section class="content-panel content-panel--flush workspace-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredWorkspaces" empty-text="暂无匹配的工作空间" @row-click="inspect">
        <el-table-column label="工作空间" min-width="280"><template #default="scope"><div class="workspace-cell"><span><el-icon><FolderOpened /></el-icon></span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small><code>{{ scope.row.id }}</code></div></div></template></el-table-column>
        <el-table-column label="创建人" min-width="150" prop="creator" />
        <el-table-column label="规模" min-width="180"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.memberCount }} 名成员 · {{ scope.row.sessionCount }} 个 Session</strong><span>{{ scope.row.fileCount }} 个文件 · {{ scope.row.artifactCount }} 个成果</span></div></template></el-table-column>
        <el-table-column prop="updatedAt" label="最近更新" width="120" />
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-workspace" @click.stop="inspect(scope.row)">查看</el-button></template></el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(610px, 100vw)" title="工作空间详情">
      <template v-if="selectedWorkspace">
        <div class="workspace-detail__hero"><span><el-icon><FolderOpened /></el-icon></span><div><h2>{{ selectedWorkspace.name }}</h2><p>{{ selectedWorkspace.description }}</p></div></div>
        <dl class="workspace-detail__rows">
          <div><dt>工作空间标识</dt><dd class="mono">{{ selectedWorkspace.id }}</dd></div>
          <div><dt>空间类型</dt><dd>团队工作空间</dd></div>
          <div><dt>创建人</dt><dd>{{ selectedWorkspace.creator }}</dd></div>
          <div><dt>成员数量</dt><dd>{{ selectedWorkspace.memberCount }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ selectedWorkspace.createdAt }}</dd></div>
          <div><dt>Session / 文件</dt><dd>{{ selectedWorkspace.sessionCount }} / {{ selectedWorkspace.fileCount }}</dd></div>
          <div><dt>成果数量</dt><dd>{{ selectedWorkspace.artifactCount }}</dd></div>
        </dl>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 320px; }
.filter-bar .el-select { width: 155px; }
.workspace-cell { display: flex; min-width: 0; align-items: center; gap: 11px; cursor: pointer; }
.workspace-cell > span,
.workspace-detail__hero > span { display: grid; width: 38px; height: 38px; flex: 0 0 auto; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-header); }
.workspace-cell > div { display: flex; min-width: 0; flex-direction: column; }
.workspace-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.workspace-cell small { max-width: 390px; margin-top: 3px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.workspace-cell code { margin-top: 3px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.workspace-detail__hero { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.workspace-detail__hero > span { width: 44px; height: 44px; }
.workspace-detail__hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.workspace-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.workspace-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.workspace-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.workspace-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.workspace-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
