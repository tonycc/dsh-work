<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Search, View } from '@element-plus/icons-vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { ModelUsageRecord } from '@/types/domain'
import {
  summarizeModelUsageByEmployee,
  type EmployeeModelUsageSummary,
} from '@/utils/model-usage'

const router = useRouter()
const contentStore = useContentStore()
const viewMode = ref<'records' | 'employees'>('records')
const query = ref('')
const employeeFilter = ref('all')
const providerFilter = ref('all')
const statusFilter = ref('all')
const selectedRecord = ref<ModelUsageRecord>()
const drawerOpen = ref(false)

const providers = computed(() =>
  [...new Set(contentStore.modelUsage.map((record) => record.provider))].sort(),
)
const employees = computed(() => {
  const options = new Map<string, Pick<ModelUsageRecord, 'employeeId' | 'employeeName' | 'department'>>()
  for (const record of contentStore.modelUsage) {
    options.set(record.employeeId, {
      employeeId: record.employeeId,
      employeeName: record.employeeName,
      department: record.department,
    })
  }
  return [...options.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName, 'zh-CN'))
})

const filteredRecords = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.modelUsage.filter((record) => {
    const matchesQuery = !keyword || `${record.employeeName} ${record.employeeId} ${record.department} ${record.provider} ${record.model} ${record.modelRoute} ${record.agentId} ${record.runId} ${record.traceId}`.toLowerCase().includes(keyword)
    const matchesEmployee = employeeFilter.value === 'all' || record.employeeId === employeeFilter.value
    const matchesProvider = providerFilter.value === 'all' || record.provider === providerFilter.value
    const matchesStatus = statusFilter.value === 'all' || record.status === statusFilter.value
    return matchesQuery && matchesEmployee && matchesProvider && matchesStatus
  })
})

const employeeSummaries = computed(() => summarizeModelUsageByEmployee(filteredRecords.value))
const totalTokens = computed(() => filteredRecords.value.reduce((sum, record) => sum + record.totalTokens, 0))
const totalCost = computed(() => filteredRecords.value.reduce((sum, record) => sum + record.costCny, 0))
const successfulRecords = computed(() => filteredRecords.value.filter((record) => record.status === 'success'))
const averageLatency = computed(() => {
  if (!successfulRecords.value.length) return 0
  return Math.round(successfulRecords.value.reduce((sum, record) => sum + record.latencyMs, 0) / successfulRecords.value.length)
})

function inspect(record: ModelUsageRecord) {
  selectedRecord.value = record
  drawerOpen.value = true
}

function showEmployeeRecords(summary: EmployeeModelUsageSummary) {
  employeeFilter.value = summary.employeeId
  viewMode.value = 'records'
}

function openAudit() {
  if (!selectedRecord.value) return
  drawerOpen.value = false
  void router.push({ path: '/audit', query: { trace: selectedRecord.value.traceId } })
}

function formatTokens(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatLatency(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`
}

function formatRate(value: number) {
  return `${Math.round(value * 100)}%`
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page model-usage-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="metric-grid">
      <article class="metric-card"><div class="metric-label">模型调用</div><div class="metric-value">{{ filteredRecords.length }}</div><div class="metric-detail">涉及 {{ employeeSummaries.length }} 名员工</div></article>
      <article class="metric-card"><div class="metric-label">Token 用量</div><div class="metric-value">{{ formatTokens(totalTokens) }}</div><div class="metric-detail">输入与输出 Token 合计</div></article>
      <article class="metric-card"><div class="metric-label">估算成本</div><div class="metric-value">¥{{ totalCost.toFixed(2) }}</div><div class="metric-detail">MVP 暂按估算口径记录</div></article>
      <article class="metric-card"><div class="metric-label">平均模型延迟</div><div class="metric-value">{{ formatLatency(averageLatency) }}</div><div class="metric-detail">只统计成功调用</div></article>
    </section>

    <section class="content-panel filter-panel usage-filter-panel">
      <div class="status-tabs" role="tablist" aria-label="模型用量查看维度">
        <button class="status-tab" :class="{ active: viewMode === 'records' }" type="button" role="tab" :aria-selected="viewMode === 'records'" @click="viewMode = 'records'">调用明细 <span class="tab-count">{{ filteredRecords.length }}</span></button>
        <button class="status-tab" :class="{ active: viewMode === 'employees' }" type="button" role="tab" :aria-selected="viewMode === 'employees'" @click="viewMode = 'employees'">员工统计 <span class="tab-count">{{ employeeSummaries.length }}</span></button>
      </div>
      <div class="filter-bar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索员工、模型、运行或链路编号" />
        <el-select v-model="employeeFilter" class="employee-filter" filterable aria-label="筛选员工">
          <el-option label="全部员工" value="all" />
          <el-option v-for="employee in employees" :key="employee.employeeId" :label="`${employee.employeeName} · ${employee.employeeId}`" :value="employee.employeeId" />
        </el-select>
        <el-select v-model="providerFilter" class="provider-filter" aria-label="筛选模型提供方">
          <el-option label="全部提供方" value="all" />
          <el-option v-for="provider in providers" :key="provider" :label="provider" :value="provider" />
        </el-select>
        <el-select v-model="statusFilter" class="status-filter" aria-label="筛选调用结果">
          <el-option label="全部结果" value="all" />
          <el-option label="成功" value="success" />
          <el-option label="失败" value="failed" />
          <el-option label="已阻止" value="blocked" />
        </el-select>
        <span class="filter-bar__meta">{{ filteredRecords.length }} 条调用 · {{ employeeSummaries.length }} 名员工</span>
      </div>
    </section>

    <section class="content-panel content-panel--flush model-usage-table">
      <el-table v-if="viewMode === 'records'" class="data-table" v-loading="contentStore.loading" :data="filteredRecords" empty-text="暂无匹配的模型调用" @row-click="inspect">
        <el-table-column prop="time" label="时间" width="164" />
        <el-table-column label="员工" min-width="170">
          <template #default="scope"><div class="employee-cell"><span>{{ scope.row.employeeName.slice(0, 1) }}</span><div><strong>{{ scope.row.employeeName }}</strong><small>{{ scope.row.employeeId }}</small></div></div></template>
        </el-table-column>
        <el-table-column label="模型" min-width="190">
          <template #default="scope"><div class="model-cell"><strong>{{ scope.row.model }}</strong><small>{{ scope.row.provider }} · {{ scope.row.modelRoute }}</small></div></template>
        </el-table-column>
        <el-table-column label="运行 / Agent" min-width="210">
          <template #default="scope"><div class="stack-cell"><span class="mono">{{ scope.row.runId }}</span><span>{{ scope.row.agentId }}</span></div></template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="125" />
        <el-table-column label="数据等级" width="95"><template #default="scope"><span class="level-tag">{{ scope.row.dataLevel }}</span></template></el-table-column>
        <el-table-column label="Token" width="110"><template #default="scope">{{ formatTokens(scope.row.totalTokens) }}</template></el-table-column>
        <el-table-column label="延迟" width="95"><template #default="scope">{{ formatLatency(scope.row.latencyMs) }}</template></el-table-column>
        <el-table-column label="成本" width="90"><template #default="scope">¥{{ scope.row.costCny.toFixed(2) }}</template></el-table-column>
        <el-table-column label="结果" width="100"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="操作" width="90" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-model-usage" @click.stop="inspect(scope.row)">详情</el-button></template></el-table-column>
      </el-table>

      <el-table v-else class="data-table" v-loading="contentStore.loading" :data="employeeSummaries" empty-text="当前筛选范围内暂无员工用量" @row-click="showEmployeeRecords">
        <el-table-column label="员工" min-width="210">
          <template #default="scope"><div class="employee-cell"><span>{{ scope.row.employeeName.slice(0, 1) }}</span><div><strong>{{ scope.row.employeeName }}</strong><small>{{ scope.row.employeeId }} · 最近 {{ scope.row.lastUsedAt }}</small></div></div></template>
        </el-table-column>
        <el-table-column prop="department" label="部门" min-width="120" />
        <el-table-column label="调用情况" min-width="180">
          <template #default="scope"><div class="usage-count-cell"><strong>{{ scope.row.callCount }} 次</strong><small>成功 {{ scope.row.successCount }} · 失败 {{ scope.row.failedCount }} · 阻止 {{ scope.row.blockedCount }}</small></div></template>
        </el-table-column>
        <el-table-column label="成功率" width="85"><template #default="scope"><span class="rate-value">{{ formatRate(scope.row.successRate) }}</span></template></el-table-column>
        <el-table-column label="Token 用量" min-width="160">
          <template #default="scope"><div class="token-cell"><strong>{{ formatTokens(scope.row.totalTokens) }}</strong><small>输入 {{ formatTokens(scope.row.promptTokens) }} · 输出 {{ formatTokens(scope.row.completionTokens) }}</small></div></template>
        </el-table-column>
        <el-table-column label="成本 / 延迟" min-width="140"><template #default="scope"><div class="usage-metric-cell"><strong>¥{{ scope.row.costCny.toFixed(2) }}</strong><small>平均 {{ scope.row.successCount ? formatLatency(scope.row.averageLatencyMs) : '—' }}</small></div></template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="scope"><el-button link type="primary" data-action="view-employee-model-usage" @click.stop="showEmployeeRecords(scope.row)">查看明细</el-button></template></el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="drawerOpen" size="min(580px, 100vw)" title="模型调用详情">
      <template v-if="selectedRecord">
        <div class="model-detail__hero">
          <div><small>{{ selectedRecord.provider }}</small><h2>{{ selectedRecord.model }}</h2><p>{{ selectedRecord.modelRoute }} · 数据等级 {{ selectedRecord.dataLevel }}</p></div>
          <StatusTag :status="selectedRecord.status" />
        </div>
        <dl class="model-detail__rows">
          <div><dt>调用时间</dt><dd>{{ selectedRecord.time }}</dd></div>
          <div><dt>员工</dt><dd>{{ selectedRecord.employeeName }}（{{ selectedRecord.employeeId }}）</dd></div>
          <div><dt>运行</dt><dd class="mono">{{ selectedRecord.runId }}</dd></div>
          <div><dt>Agent</dt><dd class="mono">{{ selectedRecord.agentId }}</dd></div>
          <div><dt>部门</dt><dd>{{ selectedRecord.department }}</dd></div>
          <div><dt>输入 Token</dt><dd>{{ formatTokens(selectedRecord.promptTokens) }}</dd></div>
          <div><dt>输出 Token</dt><dd>{{ formatTokens(selectedRecord.completionTokens) }}</dd></div>
          <div><dt>总 Token</dt><dd>{{ formatTokens(selectedRecord.totalTokens) }}</dd></div>
          <div><dt>模型延迟</dt><dd>{{ formatLatency(selectedRecord.latencyMs) }}</dd></div>
          <div><dt>估算成本</dt><dd>¥{{ selectedRecord.costCny.toFixed(2) }}</dd></div>
          <div><dt>链路编号</dt><dd class="mono">{{ selectedRecord.traceId }}</dd></div>
        </dl>
        <el-alert type="info" :closable="false" show-icon title="Token 与成本为 MVP 估算值；生产版本由模型网关按实际账单口径记录。" />
        <div class="model-detail__footer"><el-button type="primary" @click="openAudit">查看关联审计</el-button></div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.usage-filter-panel { gap: 0; }
.usage-filter-panel .filter-bar { padding-top: 10px; }
.filter-bar .el-input { width: 300px; }
.filter-bar .el-select { width: 150px; }
.filter-bar .employee-filter { width: 200px; }
.filter-bar .provider-filter { width: 170px; }
.filter-bar .status-filter { width: 140px; }
.employee-cell { display: flex; min-width: 0; align-items: center; gap: 10px; cursor: pointer; }
.employee-cell > span { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); }
.employee-cell div, .usage-count-cell, .token-cell, .usage-metric-cell { display: flex; min-width: 0; flex-direction: column; }
.employee-cell strong, .usage-count-cell strong, .token-cell strong, .usage-metric-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.employee-cell small, .usage-count-cell small, .token-cell small, .usage-metric-cell small { margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-cell { display: flex; min-width: 0; flex-direction: column; cursor: pointer; }
.model-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.model-cell small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.rate-value { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.level-tag { display: inline-flex; padding: 3px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.model-detail__hero { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.model-detail__hero small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-detail__hero h2 { margin: 4px 0 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.model-detail__hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.model-detail__rows { margin: 16px 0; }
.model-detail__rows div { display: grid; grid-template-columns: 120px 1fr; gap: 14px; padding: 10px 2px; border-bottom: 1px solid var(--color-border); }
.model-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.model-detail__rows dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); }
.model-detail__footer { margin-top: 18px; text-align: right; }
@media (max-width: 720px) { .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } }
</style>
