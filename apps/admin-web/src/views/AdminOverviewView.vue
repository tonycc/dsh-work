<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'

const router = useRouter()
const contentStore = useContentStore()

const maxRuns = computed(() => Math.max(...contentStore.usage.map((item) => item.runs), 1))
const totalRuns = computed(() => contentStore.usage.reduce((sum, item) => sum + item.runs, 0))
const totalTokens = computed(() => contentStore.usage.reduce((sum, item) => sum + item.tokens, 0))
const successRate = computed(() => {
  const finished = contentStore.tasks.filter((task) => ['succeeded', 'failed'].includes(task.status))
  if (!finished.length) return '—'
  return `${Math.round((finished.filter((task) => task.status === 'succeeded').length / finished.length) * 100)}%`
})

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page admin-overview-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section class="content-panel filter-panel">
      <div class="filter-bar">
        <p class="page-note">查看试点范围内的对话与运行、模型用量、工具可用性和需关注事件。</p>
        <div class="overview-time"><span></span>数据更新于刚刚</div>
      </div>
    </section>

    <section v-loading="contentStore.loading" class="metric-grid">
      <article class="metric-card"><div class="metric-label">近 7 日对话</div><div class="metric-value">{{ totalRuns }}</div><div class="metric-detail"><span class="metric-delta is-up">↑ 12%</span> · 50 位注册试点员工</div></article>
      <article class="metric-card"><div class="metric-label">运行成功率</div><div class="metric-value">{{ successRate }}</div><div class="metric-detail"><span class="metric-delta is-up">↑ 2.1%</span> · 不含取消与排队运行</div></article>
      <article class="metric-card"><div class="metric-label">模型 Token</div><div class="metric-value">{{ (totalTokens / 10000).toFixed(1) }} 万</div><div class="metric-detail"><span class="metric-delta is-up">↑ 8%</span> · <button class="metric-link" type="button" @click="router.push('/model-usage')">查看用量明细</button></div></article>
      <article class="metric-card"><div class="metric-label">第 95 百分位运行耗时</div><div class="metric-value">3 分 48 秒</div><div class="metric-detail"><span class="metric-delta is-down">↓ 6%</span> · 包含工具与文件处理</div></article>
    </section>

    <section class="overview-main-grid">
      <div class="content-panel content-panel--flush usage-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">运行趋势</h2><p class="panel-subtitle">近 7 日创建运行数量</p></div>
          <el-radio-group model-value="runs" size="small"><el-radio-button value="runs">运行</el-radio-button><el-radio-button value="tokens">Token</el-radio-button></el-radio-group>
        </div>
        <div v-loading="contentStore.loading" class="usage-chart" aria-label="近七日运行趋势柱状图">
          <div v-for="point in contentStore.usage" :key="point.day" class="usage-bar">
            <span class="usage-bar__value">{{ point.runs }}</span>
            <div class="usage-bar__track"><i :style="{ height: `${(point.runs / maxRuns) * 100}%` }"></i></div>
            <span class="usage-bar__day">{{ point.day }}</span>
          </div>
        </div>
      </div>

      <aside class="content-panel content-panel--flush status-panel">
        <div class="panel-header"><div><h2 class="panel-title">今日运行状态</h2><p class="panel-subtitle">实时运行分布</p></div></div>
        <div class="status-donut-wrap">
          <div class="status-donut"><div><strong>96</strong><span>今日运行</span></div></div>
          <div class="status-legend">
            <div><span class="is-success"></span><label>已完成</label><strong>78</strong><small>81.3%</small></div>
            <div><span class="is-running"></span><label>执行中</label><strong>7</strong><small>7.3%</small></div>
            <div><span class="is-waiting"></span><label>等待确认</label><strong>5</strong><small>5.2%</small></div>
            <div><span class="is-failed"></span><label>失败</label><strong>6</strong><small>6.2%</small></div>
          </div>
        </div>
      </aside>
    </section>

    <section class="overview-bottom-grid">
      <div class="content-panel content-panel--flush attention-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">需关注事项</h2><p class="panel-subtitle">系统、权限与运行风险</p></div>
          <el-button text @click="router.push('/health')">查看系统健康</el-button>
        </div>
        <div class="attention-list">
          <article>
            <span class="attention-icon attention-icon--warning">警</span>
            <div><strong>企业连接器网关尚未接入</strong><p>ERP、MES、WMS 数据当前均为服务端原型数据。</p></div>
            <StatusTag status="offline" label="未配置" />
          </article>
          <article>
            <span class="attention-icon attention-icon--blocked">权</span>
            <div><strong>1 次敏感字段读取被阻止</strong><p>采购用户尝试读取供应商价格字段，权限策略已生效。</p></div>
            <StatusTag status="blocked" />
          </article>
          <article>
            <span class="attention-icon attention-icon--info">审</span>
            <div><strong>经营分析助手等待发布评审</strong><p>版本 0.4.0 已完成测试，尚未进入员工可见范围。</p></div>
            <StatusTag status="draft" />
          </article>
        </div>
      </div>

      <div class="content-panel content-panel--flush audit-summary-panel">
        <div class="panel-header">
          <div><h2 class="panel-title">最近审计事件</h2><p class="panel-subtitle">关键调用与策略结果</p></div>
          <el-button text @click="router.push('/audit')">查看全部</el-button>
        </div>
        <div class="audit-summary-list">
          <article v-for="event in contentStore.auditEvents.slice(0, 4)" :key="event.id">
            <span class="audit-summary-list__dot" :class="`is-${event.status}`"></span>
            <div><strong>{{ event.action }} · {{ event.object }}</strong><p>{{ event.actor }} · {{ event.time }}</p></div>
            <StatusTag :status="event.status" />
          </article>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overview-time {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.overview-time span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

.metric-delta { font-weight: var(--font-weight-title); }
.metric-delta.is-up { color: var(--color-success-strong); }
.metric-delta.is-down { color: var(--color-primary); }
.metric-link { padding: 0; border: 0; color: var(--color-primary); background: transparent; cursor: pointer; font: inherit; }
.metric-link:hover { text-decoration: underline; }
.metric-link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }

.overview-main-grid,
.overview-bottom-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(320px, 0.7fr);
  gap: 14px;
}

.overview-bottom-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.usage-panel,
.status-panel,
.attention-panel,
.audit-summary-panel {
  overflow: hidden;
}

.usage-chart {
  display: flex;
  align-items: stretch;
  height: 260px;
  gap: 12px;
  padding: 25px 22px 18px;
  border-bottom: 1px solid transparent;
  background: linear-gradient(to bottom, transparent 24%, var(--color-bg-subtle) 25%, transparent 25.5%, transparent 49%, var(--color-bg-subtle) 50%, transparent 50.5%, transparent 74%, var(--color-bg-subtle) 75%, transparent 75.5%);
}

.usage-bar {
  display: grid;
  min-width: 0;
  flex: 1;
  grid-template-rows: 18px 1fr 20px;
  align-items: end;
  text-align: center;
}

.usage-bar__value {
  align-self: start;
  color: var(--color-text-secondary);
  font-size: var(--font-size-badge);
  opacity: 0;
  transition: opacity 150ms ease;
}

.usage-bar:hover .usage-bar__value {
  opacity: 1;
}

.usage-bar__track {
  display: flex;
  width: min(42px, 78%);
  height: 100%;
  align-items: end;
  justify-self: center;
}

.usage-bar__track i {
  display: block;
  width: 100%;
  min-height: 8px;
  border-radius: 5px 5px 2px 2px;
  background: var(--color-primary);
}

.usage-bar__day {
  align-self: end;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.status-donut-wrap {
  display: grid;
  grid-template-columns: 142px 1fr;
  align-items: center;
  gap: 20px;
  padding: 29px 21px;
}

.status-donut {
  display: grid;
  width: 140px;
  height: 140px;
  place-items: center;
  border-radius: 50%;
  background: conic-gradient(var(--color-success) 0 81.3%, var(--color-primary) 81.3% 88.6%, var(--color-warning) 88.6% 93.8%, var(--color-danger) 93.8% 100%);
}

.status-donut::before {
  position: absolute;
  width: 94px;
  height: 94px;
  border-radius: 50%;
  background: var(--color-bg-base);
  content: '';
}

.status-donut div {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  text-align: center;
}

.status-donut strong {
  color: var(--color-text-heading);
  font-size: var(--font-size-metric);
}

.status-donut span {
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
}

.status-legend {
  display: grid;
  gap: 13px;
}

.status-legend > div {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: center;
  gap: 7px;
}

.status-legend > div > span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

.status-legend .is-running { background: var(--color-primary); }
.status-legend .is-waiting { background: var(--color-warning); }
.status-legend .is-failed { background: var(--color-danger); }
.status-legend label { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.status-legend strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.status-legend small { grid-column: 2 / -1; color: var(--color-text-muted); font-size: var(--font-size-badge); }

.attention-list,
.audit-summary-list {
  padding: 4px 0;
}

.attention-list article,
.audit-summary-list article {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
  min-height: 68px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--color-border);
}

.attention-list article:last-child,
.audit-summary-list article:last-child {
  border-bottom: 0;
}

.attention-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: var(--radius-button);
  color: var(--color-warning-strong);
  background: var(--color-warning-light);
  font-size: var(--font-size-badge);
  font-weight: var(--font-weight-heading);
}

.attention-icon--blocked { color: var(--color-danger-strong); background: var(--color-danger-light); }
.attention-icon--info { color: var(--color-primary); background: var(--color-primary-light); }
.attention-list strong,
.audit-summary-list strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.attention-list p,
.audit-summary-list p { margin: 4px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.45; }

.audit-summary-list article {
  grid-template-columns: 8px minmax(0, 1fr) auto;
}

.audit-summary-list__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

.audit-summary-list__dot.is-failed { background: var(--color-danger); }
.audit-summary-list__dot.is-blocked { background: var(--color-warning); }

@media (max-width: 1180px) {
  .metric-grid { grid-template-columns: repeat(2, 1fr); }
  .overview-main-grid { grid-template-columns: 1fr; }
}

@media (max-width: 860px) {
  .overview-bottom-grid { grid-template-columns: 1fr; }
}

@media (max-width: 600px) {
  .metric-grid { grid-template-columns: 1fr; }
  .status-donut-wrap { grid-template-columns: 1fr; justify-items: center; }
  .status-legend { width: 100%; }
}
</style>
