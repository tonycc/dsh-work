<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { FolderOpened, Search, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { ManagedWorkspaceDefinition } from '@/types/domain'

const contentStore = useContentStore()
const query = ref('')
const departmentFilter = ref('all')
const statusFilter = ref('all')
const selectedWorkspace = ref<ManagedWorkspaceDefinition>()
const drawerOpen = ref(false)

const departments = computed(() =>
  [...new Set(contentStore.workspaces.map((workspace) => workspace.ownerDepartment))].sort(),
)
const filteredWorkspaces = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.workspaces.filter((workspace) => {
    const matchesQuery = !keyword || `${workspace.name} ${workspace.id} ${workspace.description} ${workspace.ownerDepartment} ${workspace.manager}`.toLowerCase().includes(keyword)
    const matchesDepartment = departmentFilter.value === 'all' || workspace.ownerDepartment === departmentFilter.value
    const matchesStatus = statusFilter.value === 'all' || workspace.status === statusFilter.value
    return matchesQuery && matchesDepartment && matchesStatus
  })
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
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工作空间、责任团队或负责人" />
        <el-select v-model="departmentFilter" aria-label="筛选责任团队"><el-option label="全部责任团队" value="all" /><el-option v-for="department in departments" :key="department" :label="department" :value="department" /></el-select>
        <el-select v-model="statusFilter" aria-label="筛选工作空间状态"><el-option label="全部状态" value="all" /><el-option label="正常" value="active" /><el-option label="已归档" value="archived" /></el-select>
        <span class="filter-bar__meta">{{ filteredWorkspaces.length }} 个团队工作空间</span>
      </div>
    </section>

    <el-alert type="info" :closable="false" show-icon title="一期只支持团队工作空间。工作空间归属责任团队，不绑定创建人个人名下；负责人负责日常成员与数据范围维护。" />

    <section v-loading="contentStore.loading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">团队工作空间</div><div class="metric-value">{{ contentStore.workspaces.length }}</div><div class="metric-detail">一期不创建个人空间</div></article>
      <article class="metric-card"><div class="metric-label">成员席位</div><div class="metric-value">{{ memberTotal }}</div><div class="metric-detail">按工作空间成员关系累计</div></article>
      <article class="metric-card"><div class="metric-label">空间内 Session</div><div class="metric-value">{{ sessionTotal }}</div><div class="metric-detail">继承工作空间上下文</div></article>
      <article class="metric-card"><div class="metric-label">空间成果</div><div class="metric-value">{{ artifactTotal }}</div><div class="metric-detail">团队可复用交付物</div></article>
    </section>

    <section class="content-panel content-panel--flush workspace-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredWorkspaces" empty-text="暂无匹配的工作空间" @row-click="inspect">
        <el-table-column label="工作空间" min-width="280"><template #default="scope"><div class="workspace-cell"><span><el-icon><FolderOpened /></el-icon></span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small><code>{{ scope.row.id }}</code></div></div></template></el-table-column>
        <el-table-column label="责任归属" min-width="170"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.ownerDepartment }}</strong><span>负责人 {{ scope.row.manager }}</span></div></template></el-table-column>
        <el-table-column label="规模" min-width="180"><template #default="scope"><div class="stack-cell"><strong>{{ scope.row.memberCount }} 名成员 · {{ scope.row.sessionCount }} 个 Session</strong><span>{{ scope.row.fileCount }} 个文件 · {{ scope.row.artifactCount }} 个成果</span></div></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" :label="scope.row.status === 'active' ? '正常' : '已归档'" dot /></template></el-table-column>
        <el-table-column prop="updatedAt" label="最近更新" width="120" />
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-workspace" @click.stop="inspect(scope.row)">查看</el-button></template></el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(610px, 100vw)" title="工作空间治理详情">
      <template v-if="selectedWorkspace">
        <div class="workspace-detail__hero"><span><el-icon><FolderOpened /></el-icon></span><div><h2>{{ selectedWorkspace.name }}</h2><p>{{ selectedWorkspace.description }}</p></div><StatusTag :status="selectedWorkspace.status" :label="selectedWorkspace.status === 'active' ? '正常' : '已归档'" /></div>
        <dl class="workspace-detail__rows">
          <div><dt>工作空间标识</dt><dd class="mono">{{ selectedWorkspace.id }}</dd></div>
          <div><dt>空间类型</dt><dd>团队工作空间</dd></div>
          <div><dt>责任团队</dt><dd>{{ selectedWorkspace.ownerDepartment }}</dd></div>
          <div><dt>负责人</dt><dd>{{ selectedWorkspace.manager }}</dd></div>
          <div><dt>成员数量</dt><dd>{{ selectedWorkspace.memberCount }}</dd></div>
          <div><dt>创建时间</dt><dd>{{ selectedWorkspace.createdAt }}</dd></div>
          <div><dt>Session / 文件</dt><dd>{{ selectedWorkspace.sessionCount }} / {{ selectedWorkspace.fileCount }}</dd></div>
          <div><dt>成果数量</dt><dd>{{ selectedWorkspace.artifactCount }}</dd></div>
        </dl>
        <section class="workspace-detail__section"><h3>成员</h3><div class="workspace-chip-list"><span v-for="member in selectedWorkspace.members" :key="member">{{ member }}</span></div></section>
        <section class="workspace-detail__section"><h3>可用 Agent</h3><div class="workspace-chip-list"><span v-for="agent in selectedWorkspace.agentNames" :key="agent">{{ agent }}</span></div></section>
        <section class="workspace-detail__section"><h3>业务数据范围</h3><div class="workspace-chip-list workspace-chip-list--neutral"><span v-for="scope in selectedWorkspace.dataScopes" :key="scope">{{ scope }}</span></div></section>
        <el-alert type="info" :closable="false" show-icon title="成员进入工作空间后，只能在本人企业权限与工作空间数据范围的交集内使用 Agent、文件和业务数据。" />
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
.workspace-detail__section { margin: 20px 0; }
.workspace-detail__section h3 { margin: 0 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.workspace-chip-list { display: flex; flex-wrap: wrap; gap: 6px; }
.workspace-chip-list span { padding: 4px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.workspace-chip-list--neutral span { color: var(--color-text-secondary); background: var(--color-bg-subtle); }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
