<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type { WorkspaceUsage, WorkspaceUsageRange } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

/**
 * 空间用量详情（TW-09 / 4-T2，design §2.10）。
 *
 * 只覆盖读取轨：负责人／管理员可切换 `7 天 / 30 天` 查看按日零填充的合计与明细。
 * 界面**不出现任何金额字段**（口径 §1：金额恒为 0，展示会误导）。角色门禁由宿主
 * 负责：宿主只在该角色可见时挂载本组件，因此本组件自身不做权限渲染分支。
 */
const props = withDefaults(defineProps<{
  open: boolean
  workspaceId: string
  workspaceName: string
}>(), {})

const emit = defineEmits<{
  'update:open': [boolean]
}>()

const rangeOptions: Array<{ value: WorkspaceUsageRange; label: string }> = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
]

const range = ref<WorkspaceUsageRange>('7d')
const usage = ref<WorkspaceUsage | null>(null)
const loading = ref(false)
const error = ref(false)

/**
 * 请求世代 + 发起时的 (空间, time window) 三重比对：切换空间、切换时间窗或关闭再打开
 * 时，晚到的旧响应不得写进当前弹窗（与 3-T9 版本弹窗同一防竞态口径）。
 */
let requestSeq = 0

function isCurrentRequest(seq: number, workspaceId: string, requestedRange: WorkspaceUsageRange) {
  return seq === requestSeq
    && workspaceId === props.workspaceId
    && requestedRange === range.value
}

/** 展示计数一律规范化：越界值不得渲染成负数、小数或 NaN。 */
function normalizeCount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0
}

/** 合计行：缺字段时按 0 兜底，避免整行 `undefined`。 */
const totals = computed(() => {
  const source = usage.value?.totals
  if (!source) return null
  return {
    callCount: normalizeCount(source.callCount),
    successCount: normalizeCount(source.successCount),
    failedCount: normalizeCount(source.failedCount),
    estimatedCount: normalizeCount(source.estimatedCount),
    inputTokens: normalizeCount(source.inputTokens),
    outputTokens: normalizeCount(source.outputTokens),
    totalTokens: normalizeCount(source.totalTokens),
  }
})

/** 每日明细：越界响应（非数组/缺字段）不得掀翻弹窗。 */
const dailyRows = computed(() => {
  const rows = usage.value?.daily
  if (!Array.isArray(rows)) return []
  return rows.map(row => ({
    day: typeof row?.day === 'string' && row.day ? row.day : '—',
    callCount: normalizeCount(row?.callCount),
    successCount: normalizeCount(row?.successCount),
    failedCount: normalizeCount(row?.failedCount),
    inputTokens: normalizeCount(row?.inputTokens),
    outputTokens: normalizeCount(row?.outputTokens),
  }))
})

const estimatedCount = computed(() => totals.value?.estimatedCount ?? 0)

/**
 * 按时间窗读取用量。失败时清空数据并进入错误态——绝不把失败渲染成「零消耗」。
 */
async function loadUsage(workspaceId = props.workspaceId, requestedRange = range.value) {
  if (!workspaceId) return
  const seq = ++requestSeq
  loading.value = true
  try {
    const result = await workbenchApi.listWorkspaceUsage(workspaceId, { range: requestedRange })
    if (!isCurrentRequest(seq, workspaceId, requestedRange)) return
    usage.value = result
    error.value = false
  } catch (cause) {
    if (!isCurrentRequest(seq, workspaceId, requestedRange)) return
    usage.value = null
    error.value = true
    notifyActionFailure('加载空间用量', `工作空间“${props.workspaceName}”`, cause, '稍后点击「重试」；若仍失败，请联系工作空间管理员。')
  } finally {
    if (isCurrentRequest(seq, workspaceId, requestedRange)) loading.value = false
  }
}

function setRange(value: WorkspaceUsageRange) {
  if (range.value === value) return
  range.value = value
  void loadUsage()
}

/**
 * 打开、切换空间、关闭都先作废在途请求并清空上一份结果：宿主在关闭后仍保留
 * `workspaceId`，因此「关闭 A → 打开 B」会复用同一实例，不清空就会把 A 的用量
 * 渲染在 B 的名称之下（与 3-T9 版本弹窗同一评审结论）。
 */
watch(
  () => [props.open, props.workspaceId] as const,
  ([open]) => {
    requestSeq += 1
    usage.value = null
    error.value = false
    loading.value = false
    range.value = '7d'
    if (!open) return
    void loadUsage()
  },
  { immediate: true },
)

/** 组件卸载（例如切换空间）后在途请求一律作废，避免已离开的弹窗再弹失败提示。 */
onBeforeUnmount(() => {
  requestSeq += 1
})
</script>

<template>
  <el-dialog
    :model-value="open"
    class="workspace-usage"
    width="min(720px, calc(100vw - 32px))"
    :show-close="false"
    @update:model-value="(value: boolean) => emit('update:open', value)"
  >
    <!--
      不传 `title` 是有意的：Element Plus 在 `title` 存在时会写死 aria-label，
      不传时才写 `aria-labelledby=titleId`，这样下面这个同时含「空间用量」与空间名的
      元素才能成为可访问名称（3-T9 同一教训）。
    -->
    <template #header="{ titleId, titleClass }">
      <div class="workspace-usage__header">
        <div :id="titleId" class="workspace-usage__title">
          <span :class="titleClass">空间用量</span>
          <strong>{{ workspaceName }}</strong>
        </div>
        <button
          data-testid="usage-close"
          class="workspace-usage__close"
          type="button"
          aria-label="关闭空间用量"
          @click="emit('update:open', false)"
        >
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </template>

    <div data-testid="usage-dialog" class="workspace-usage__body">
      <div class="workspace-usage__toolbar" role="group" aria-label="统计时间窗">
        <span class="workspace-usage__toolbar-label">统计时间窗</span>
        <button
          v-for="option in rangeOptions"
          :key="option.value"
          :data-testid="`usage-range-${option.value}`"
          class="workspace-usage__range"
          :class="{ 'is-active': range === option.value }"
          type="button"
          :aria-pressed="range === option.value"
          @click="setRange(option.value)"
        >
          {{ option.label }}
        </button>
      </div>

      <p class="workspace-usage__hint">
        统计该空间全部会话的模型消耗；只展示调用次数与 token 计数（含成功／失败拆分）。估算值表示平台估算而非 DSH 上报。
      </p>

      <el-skeleton
        v-if="loading && !usage"
        data-testid="usage-skeleton"
        class="workspace-usage__skeleton"
        :rows="4"
        animated
      />

      <div v-else-if="error" data-testid="usage-error" class="workspace-usage__error">
        <p>用量加载失败</p>
        <el-button data-testid="usage-retry" @click="loadUsage()">重试</el-button>
      </div>

      <template v-else-if="usage && totals">
        <dl data-testid="usage-totals" class="workspace-usage__totals">
          <div>
            <dt>调用次数</dt>
            <dd>{{ totals.callCount }}</dd>
          </div>
          <div>
            <dt>成功</dt>
            <dd>{{ totals.successCount }}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{{ totals.failedCount }}</dd>
          </div>
          <div>
            <dt>input tokens</dt>
            <dd>{{ totals.inputTokens }}</dd>
          </div>
          <div>
            <dt>output tokens</dt>
            <dd>{{ totals.outputTokens }}</dd>
          </div>
          <div>
            <dt>total tokens</dt>
            <dd>{{ totals.totalTokens }}</dd>
          </div>
        </dl>

        <p v-if="estimatedCount > 0" data-testid="usage-estimated" class="workspace-usage__estimated">
          其中 {{ estimatedCount }} 次为估算值
        </p>

        <table v-if="dailyRows.length" data-testid="usage-daily-table" class="workspace-usage__table">
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">调用次数</th>
              <th scope="col">成功</th>
              <th scope="col">失败</th>
              <th scope="col">input tokens</th>
              <th scope="col">output tokens</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dailyRows" :key="row.day" data-testid="usage-daily-row">
              <td>{{ row.day }}</td>
              <td>{{ row.callCount }}</td>
              <td>{{ row.successCount }}</td>
              <td>{{ row.failedCount }}</td>
              <td>{{ row.inputTokens }}</td>
              <td>{{ row.outputTokens }}</td>
            </tr>
          </tbody>
        </table>

        <p v-else data-testid="usage-empty" class="workspace-usage__empty">该时间窗内暂无用量记录</p>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.workspace-usage__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-usage__title {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-usage__title strong {
  overflow: hidden;
  margin-top: 3px;
  color: #4d534e;
  font-size: var(--dsh-font-size-badge);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-usage__close {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  color: #7d827d;
  background: transparent;
  cursor: pointer;
}

.workspace-usage__close:hover {
  border-color: #dfe3df;
  color: #244d40;
  background: #f5f8f6;
}

.workspace-usage__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.workspace-usage__toolbar-label {
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
}

.workspace-usage__range {
  padding: 4px 12px;
  border: 1px solid #e0e4e0;
  border-radius: 999px;
  color: #4d534e;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
}

.workspace-usage__range.is-active {
  border-color: #2a7a63;
  color: #155e4b;
  background: #e8f4ef;
  font-weight: 650;
}

.workspace-usage__hint {
  margin: 10px 0 0;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.workspace-usage__skeleton {
  margin-top: 12px;
  padding: 2px;
}

.workspace-usage__error {
  padding: 18px 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-caption);
  text-align: center;
}

.workspace-usage__totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
}

.workspace-usage__totals > div {
  padding: 9px 11px;
  border: 1px solid #e5e8e4;
  border-radius: 10px;
  background: #fff;
}

.workspace-usage__totals dt {
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
}

.workspace-usage__totals dd {
  margin: 4px 0 0;
  color: #232723;
  font-size: var(--dsh-font-size-section);
  font-weight: 650;
}

.workspace-usage__estimated {
  margin: 10px 0 0;
  color: #6c726d;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.workspace-usage__table {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-size: var(--dsh-font-size-micro);
}

.workspace-usage__table th,
.workspace-usage__table td {
  padding: 7px 8px;
  border-bottom: 1px solid #eef0ed;
  text-align: right;
}

.workspace-usage__table th:first-child,
.workspace-usage__table td:first-child {
  text-align: left;
}

.workspace-usage__table th {
  color: #8b918c;
  font-weight: 600;
}

.workspace-usage__table td {
  color: #3b403c;
}

.workspace-usage__empty {
  margin: 14px 0 0;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}
</style>
