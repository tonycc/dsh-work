<script setup lang="ts">
import { Check, Clock, Close, Loading, Lock } from '@element-plus/icons-vue'

type TimelineStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'awaiting_approval'

interface TimelineStep {
  id: string
  title: string
  detail: string
  status: TimelineStepStatus
  tool?: string
  duration?: string
}

defineProps<{
  steps: TimelineStep[]
}>()

const icons = {
  pending: Clock,
  running: Loading,
  succeeded: Check,
  failed: Close,
  awaiting_approval: Lock,
}
</script>

<template>
  <ol class="run-timeline">
    <li v-for="(step, index) in steps" :key="step.id" class="run-step" :class="`run-step--${step.status}`">
      <div class="run-step__rail">
        <span class="run-step__index">
          <el-icon :class="{ 'is-loading': step.status === 'running' }">
            <component :is="icons[step.status]" />
          </el-icon>
        </span>
        <span v-if="index < steps.length - 1" class="run-step__line"></span>
      </div>
      <div class="run-step__content">
        <div class="run-step__heading">
          <strong>{{ step.title }}</strong>
          <span v-if="step.duration">{{ step.duration }}</span>
        </div>
        <p>{{ step.detail }}</p>
        <code v-if="step.tool">{{ step.tool }}</code>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.run-timeline {
  margin: 0;
  padding: 2px 0 0;
  list-style: none;
}

.run-step {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 10px;
  min-height: 75px;
}

.run-step__rail {
  position: relative;
  display: flex;
  justify-content: center;
}

.run-step__index {
  position: relative;
  z-index: 2;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid #dce1e9;
  border-radius: 50%;
  color: #929baa;
  background: #fff;
  font-size: var(--dsh-font-size-body);
}

.run-step__line {
  position: absolute;
  z-index: 1;
  top: 25px;
  bottom: -1px;
  width: 1px;
  background: #e0e4eb;
}

.run-step__content {
  padding: 2px 0 18px;
}

.run-step__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.run-step__heading strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
  font-weight: 620;
}

.run-step__heading span {
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-badge);
}

.run-step p {
  margin: 5px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.55;
}

.run-step code {
  display: inline-block;
  margin-top: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  color: #536079;
  background: #f2f4f7;
  font-size: var(--dsh-font-size-badge);
}

.run-step--succeeded .run-step__index {
  border-color: #bde5d5;
  color: var(--dsh-color-success);
  background: var(--dsh-color-success-soft);
}

.run-step--succeeded .run-step__line {
  background: #cceade;
}

.run-step--running .run-step__index {
  border-color: #bfd0fc;
  color: var(--dsh-color-brand);
  background: var(--dsh-color-brand-soft);
}

.run-step--failed .run-step__index {
  border-color: #f1bec5;
  color: var(--dsh-color-danger);
  background: var(--dsh-color-danger-soft);
}

.run-step--awaiting_approval .run-step__index {
  border-color: #f0d2a9;
  color: var(--dsh-color-warning);
  background: var(--dsh-color-warning-soft);
}
</style>
