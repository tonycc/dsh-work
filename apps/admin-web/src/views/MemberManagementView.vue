<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { MemberDefinition } from '@/types/domain'

const contentStore = useContentStore()
const query = ref('')
const departmentFilter = ref('all')
const statusFilter = ref('all')
const selectedMember = ref<MemberDefinition>()
const drawerOpen = ref(false)

const departments = computed(() =>
  [...new Set(contentStore.members.map((member) => member.department))].sort(),
)

const filteredMembers = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.members.filter((member) => {
    const matchesQuery = !keyword || `${member.name} ${member.id} ${member.title} ${member.department} ${member.roleNames.join(' ')}`.toLowerCase().includes(keyword)
    const matchesDepartment = departmentFilter.value === 'all' || member.department === departmentFilter.value
    const matchesStatus = statusFilter.value === 'all' || member.status === statusFilter.value
    return matchesQuery && matchesDepartment && matchesStatus
  })
})

const selectedRoles = computed(() => {
  if (!selectedMember.value) return []
  return contentStore.roles.filter((role) => selectedMember.value?.roleIds.includes(role.id))
})

const effectiveAgents = computed(() =>
  [...new Set(selectedRoles.value.flatMap((role) => role.agents))],
)

const effectiveTools = computed(() =>
  [...new Set(selectedRoles.value.flatMap((role) => role.tools))],
)

function inspect(member: MemberDefinition) {
  selectedMember.value = member
  drawerOpen.value = true
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page member-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索成员、工号、部门或角色" />
        <el-select v-model="departmentFilter" aria-label="筛选部门">
          <el-option label="全部部门" value="all" />
          <el-option v-for="department in departments" :key="department" :label="department" :value="department" />
        </el-select>
        <el-select v-model="statusFilter" aria-label="筛选成员状态">
          <el-option label="全部状态" value="all" />
          <el-option label="正常" value="active" />
          <el-option label="已停用" value="suspended" />
        </el-select>
        <span class="filter-bar__meta">{{ filteredMembers.length }} 名成员</span>
      </div>
    </section>

    <section class="content-panel content-panel--flush member-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredMembers" empty-text="暂无匹配的成员" @row-click="inspect">
        <el-table-column label="成员" min-width="230">
          <template #default="scope">
            <div class="member-cell">
              <span>{{ scope.row.avatarText }}</span>
              <div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.id }} · {{ scope.row.title }}</small></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="140" />
        <el-table-column label="平台角色" min-width="230">
          <template #default="scope"><div class="tag-list"><span v-for="role in scope.row.roleNames" :key="role">{{ role }}</span></div></template>
        </el-table-column>
        <el-table-column label="数据范围" min-width="250">
          <template #default="scope"><span class="scope-copy">{{ scope.row.dataScopes.join('、') }}</span></template>
        </el-table-column>
        <el-table-column label="企业单点登录" width="130">
          <template #default="scope"><StatusTag :status="scope.row.ssoStatus === 'synced' ? 'synced' : 'pending_sync'" :label="scope.row.ssoStatus === 'synced' ? '已同步' : '待同步'" dot /></template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="scope"><StatusTag :status="scope.row.status" :label="scope.row.status === 'active' ? '正常' : '已停用'" /></template>
        </el-table-column>
        <el-table-column prop="lastActiveAt" label="最近活跃" width="135" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="scope"><el-button link type="primary" :icon="View" data-action="view-member" @click.stop="inspect(scope.row)">查看</el-button></template>
        </el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(560px, 100vw)" title="成员与有效权限">
      <template v-if="selectedMember">
        <div class="member-detail__hero">
          <span>{{ selectedMember.avatarText }}</span>
          <div><h2>{{ selectedMember.name }}</h2><p>{{ selectedMember.id }} · {{ selectedMember.department }} · {{ selectedMember.title }}</p></div>
          <StatusTag :status="selectedMember.status" :label="selectedMember.status === 'active' ? '正常' : '已停用'" />
        </div>
        <dl class="member-detail__meta">
          <div><dt>企业单点登录</dt><dd>{{ selectedMember.ssoStatus === 'synced' ? '身份已同步' : '等待首次同步' }}</dd></div>
          <div><dt>最近活跃</dt><dd>{{ selectedMember.lastActiveAt }}</dd></div>
          <div><dt>平台角色</dt><dd>{{ selectedMember.roleNames.join('、') }}</dd></div>
          <div><dt>业务数据范围</dt><dd>{{ selectedMember.dataScopes.join('、') }}</dd></div>
        </dl>
        <section class="member-detail__section"><h3>有效 Agent</h3><div class="chip-list"><span v-for="agent in effectiveAgents" :key="agent">{{ agent }}</span><em v-if="!effectiveAgents.length">无</em></div></section>
        <section class="member-detail__section"><h3>有效工具</h3><div class="chip-list chip-list--neutral"><span v-for="tool in effectiveTools" :key="tool">{{ tool }}</span><em v-if="!effectiveTools.length">无</em></div></section>
        <el-alert type="info" :closable="false" show-icon title="有效权限由企业单点登录身份、平台角色与实时业务数据范围共同决定。" />
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 150px; }
.member-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.member-cell > span,
.member-detail__hero > span { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-caption); font-weight: var(--font-weight-heading); }
.member-cell > div { display: flex; min-width: 0; flex-direction: column; }
.member-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.member-cell small { margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.tag-list,
.chip-list { display: flex; flex-wrap: wrap; gap: 5px; }
.tag-list span,
.chip-list span { padding: 4px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.scope-copy { color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.member-detail__hero { display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.member-detail__hero > span { width: 44px; height: 44px; }
.member-detail__hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.member-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.member-detail__meta { margin: 16px 0 0; }
.member-detail__meta div { display: grid; grid-template-columns: 110px 1fr; gap: 14px; padding: 11px 2px; border-bottom: 1px solid var(--color-border); }
.member-detail__meta dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.member-detail__meta dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.member-detail__section { margin: 22px 0; }
.member-detail__section h3 { margin: 0 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.chip-list--neutral span { color: var(--color-text-secondary); background: var(--color-bg-subtle); }
.chip-list em { color: var(--color-text-muted); font-size: var(--font-size-caption); font-style: normal; }
@media (max-width: 720px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
