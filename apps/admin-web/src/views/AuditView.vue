<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Download, Search, View } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { AuditEvent } from '@/types/domain'

const contentStore = useContentStore()
const route = useRoute()
const query = ref('')
const statusFilter = ref('all')
const actionFilter = ref('all')
const selectedEvent = ref<AuditEvent>()
const drawerOpen = ref(false)

const filteredEvents = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.auditEvents.filter((event) => {
    const matchesQuery = !keyword || `${event.actor} ${event.object} ${event.traceId} ${event.detail}`.toLowerCase().includes(keyword)
    const matchesStatus = statusFilter.value === 'all' || event.status === statusFilter.value
    const matchesAction = actionFilter.value === 'all' || event.action === actionFilter.value
    return matchesQuery && matchesStatus && matchesAction
  })
})

function inspect(event: AuditEvent) {
  selectedEvent.value = event
  drawerOpen.value = true
}

function exportAudit() {
  ElMessage.success('已生成脱敏审计导出文件（原型）')
}

onMounted(() => {
  if (typeof route.query.trace === 'string') query.value = route.query.trace
  void contentStore.load()
})
</script>

<template>
  <div class="ops-page audit-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索用户、对象、链路编号或摘要" />
        <el-select v-model="actionFilter" aria-label="筛选审计事件类型"><el-option label="全部事件" value="all" /><el-option label="创建运行" value="创建运行" /><el-option label="模型调用" value="模型调用" /><el-option label="工具调用" value="工具调用" /><el-option label="连接器调用" value="连接器调用" /><el-option label="发布成果" value="发布成果" /></el-select>
        <el-select v-model="statusFilter" aria-label="筛选审计结果"><el-option label="全部结果" value="all" /><el-option label="成功" value="success" /><el-option label="失败" value="failed" /><el-option label="已阻止" value="blocked" /></el-select>
        <span class="filter-bar__meta">{{ filteredEvents.length }} 条事件</span>
        <el-button :icon="Download" @click="exportAudit">导出当前结果</el-button>
      </div>
    </section>

    <section class="content-panel content-panel--flush audit-panel">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredEvents" empty-text="没有匹配的审计记录" @row-click="inspect">
        <el-table-column prop="time" label="时间" width="164" />
        <el-table-column label="操作者" min-width="150"><template #default="scope"><div class="actor-cell"><strong>{{ scope.row.actor }}</strong><small>{{ scope.row.department }}</small></div></template></el-table-column>
        <el-table-column prop="action" label="事件" width="125" />
        <el-table-column label="对象" min-width="260"><template #default="scope"><span class="object-cell mono">{{ scope.row.object }}</span></template></el-table-column>
        <el-table-column label="结果" width="105"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="链路编号" min-width="150"><template #default="scope"><code>{{ scope.row.traceId }}</code></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-audit" @click.stop="inspect(scope.row)">详情</el-button></template></el-table-column>
      </el-table>
      <div class="table-footer audit-footer"><span>审计数据默认只读，原型不支持删除</span><el-pagination background layout="prev, pager, next" :total="filteredEvents.length" :page-size="10" /></div>
    </section>

    <el-drawer v-model="drawerOpen" size="min(570px, 100vw)" title="审计事件详情">
      <template v-if="selectedEvent">
        <div class="audit-detail__hero"><span :class="`is-${selectedEvent.status}`"></span><div><small>{{ selectedEvent.action }}</small><h2>{{ selectedEvent.object }}</h2></div><StatusTag :status="selectedEvent.status" /></div>
        <dl class="audit-detail__rows">
          <div><dt>发生时间</dt><dd>{{ selectedEvent.time }}</dd></div>
          <div><dt>操作者</dt><dd>{{ selectedEvent.actor }} · {{ selectedEvent.department }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selectedEvent.traceId }}</dd></div>
          <div><dt>事件对象</dt><dd class="mono">{{ selectedEvent.object }}</dd></div>
          <div class="audit-detail__wide"><dt>脱敏摘要</dt><dd>{{ selectedEvent.detail }}</dd></div>
        </dl>
        <el-alert type="info" :closable="false" show-icon title="身份上下文、授权结果和业务对象标识由后端记录；模型无法修改这些字段。" />
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 145px; }
.actor-cell { display: flex; flex-direction: column; }
.actor-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.actor-cell small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.object-cell { display: block; overflow: hidden; color: var(--color-text-primary); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.audit-panel code { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.audit-footer { margin: 0; padding: 14px 16px; }
.audit-footer span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-detail__hero { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.audit-detail__hero > span { width: 8px; height: 36px; border-radius: 4px; background: var(--color-success); }
.audit-detail__hero > span.is-failed { background: var(--color-danger); }
.audit-detail__hero > span.is-blocked { background: var(--color-warning); }
.audit-detail__hero small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-detail__hero h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.audit-detail__rows { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 22px; margin: 18px 0; }
.audit-detail__rows div { padding: 11px 0; border-bottom: 1px solid var(--color-border); }
.audit-detail__wide { grid-column: 1 / -1; }
.audit-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.audit-detail__rows dd { margin: 5px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.6; }
@media (max-width: 760px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
