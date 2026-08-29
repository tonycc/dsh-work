<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import { Bottom, Minus, Top } from '@element-plus/icons-vue'

const props = defineProps<{
  label: string
  value: string | number
  detail: string
  trend?: number
  icon: Component
  tone?: 'blue' | 'green' | 'amber' | 'violet'
}>()

const trendIcon = computed(() => {
  if (props.trend === undefined || props.trend === 0) return Minus
  return props.trend > 0 ? Top : Bottom
})
</script>

<template>
  <article class="metric-card panel" :class="`metric-card--${tone ?? 'blue'}`">
    <div class="metric-card__top">
      <span class="metric-card__icon"><el-icon><component :is="icon" /></el-icon></span>
      <span v-if="trend !== undefined" class="metric-card__trend" :class="{ 'is-negative': trend < 0 }">
        <el-icon><component :is="trendIcon" /></el-icon>
        {{ Math.abs(trend) }}%
      </span>
    </div>
    <strong class="metric-card__value">{{ value }}</strong>
    <span class="metric-card__label">{{ label }}</span>
    <small>{{ detail }}</small>
  </article>
</template>

<style scoped>
.metric-card {
  min-width: 0;
  padding: 18px;
}

.metric-card__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.metric-card__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 9px;
  color: #315fc7;
  background: #edf3ff;
  font-size: var(--dsh-font-size-section);
}

.metric-card--green .metric-card__icon {
  color: #147454;
  background: #eaf7f1;
}

.metric-card--amber .metric-card__icon {
  color: #ad510f;
  background: #fff3e4;
}

.metric-card--violet .metric-card__icon {
  color: #6d4bc3;
  background: #f3efff;
}

.metric-card__trend {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--dsh-color-success);
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.metric-card__trend.is-negative {
  color: var(--dsh-color-danger);
}

.metric-card__value {
  display: block;
  margin-top: 17px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-metric);
  font-weight: 690;
  letter-spacing: -0.03em;
}

.metric-card__label {
  display: block;
  margin-top: 4px;
  color: #46536a;
  font-size: var(--dsh-font-size-body);
  font-weight: 580;
}

.metric-card small {
  display: block;
  margin-top: 7px;
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-badge);
}
</style>
