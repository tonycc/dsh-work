<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'

import { adminApi } from '@/api/client'
import type { PlatformConfig, PlatformSetting, RuntimeParameterEntry, RuntimeParameterSource } from '@/types/domain'

/**
 * 平台配置（运行参数配置方案 6.6）：“配置”修改全平台集中的参数，按“平台配置”修改权限保存，
 * 安全类参数只有平台管理员能保存（RP12、RP16）；“总览”只读汇总全部参数与超时链路。
 */
type Tab = 'settings' | 'overview'

const tab = ref<Tab>('settings')
const data = ref<PlatformConfig>()
const loading = ref(false)
const error = ref('')
const savedNotice = ref('')
const drafts = reactive<Record<string, string>>({})
const confirmOpen = ref(false)
const riskAcknowledged = ref(false)
const saving = ref(false)
const sourceFilter = ref<RuntimeParameterSource | 'all'>('all')
const query = ref('')

const sourceLabels: Record<RuntimeParameterSource, string> = {
  page: '页面配置', default: '默认值', env: '环境变量', builtin: '系统内置', deploy: '部署脚本',
}
const groupTitles: Record<RuntimeParameterEntry['group'], string> = {
  config: '平台配置（本页修改）', other: '留在原页面', run: '运行与模型（暂不可修改）', identity: '登录（暂不可修改）', fixed: '只读：系统内置与启动参数',
}
const moduleLabels: Record<string, string> = { agent: 'Agent', config: '平台配置', dingtalk: '钉钉集成', knowledge: '企业知识库' }

const canSave = computed(() => data.value?.canSave === true)
const hasLockedItems = computed(() => (data.value?.settings ?? []).some(setting => setting.available && !setting.canEdit))

function formatValue(setting: Pick<PlatformSetting, 'unit'>, value: number | string) {
  return setting.unit === '%' ? `${value}%` : `${value} ${setting.unit}`
}

function parsed(setting: PlatformSetting) {
  const text = (drafts[setting.key] ?? '').trim()
  return /^-?\d+$/.test(text) ? Number(text) : Number.NaN
}

/** 存储值不是整页面单位时页面不预填：留空表示不修改（PR 180 评审 I4）。 */
function untouchedInexact(setting: PlatformSetting) {
  return !setting.exact && (drafts[setting.key] ?? '').trim() === ''
}

function invalid(setting: PlatformSetting) {
  if (untouchedInexact(setting)) return false
  const value = parsed(setting)
  return !Number.isInteger(value) || value < setting.min || value > setting.max
}

/** 数值相同（例如“05”与 5）不算修改；不合法的输入算修改，以便提示；不是整单位的值填入任何数都算修改。 */
function changed(setting: PlatformSetting) {
  if (untouchedInexact(setting)) return false
  return invalid(setting) || !setting.exact || parsed(setting) !== setting.value
}

function currentText(setting: PlatformSetting) {
  return setting.exact ? formatValue(setting, setting.value) : setting.actual ?? formatValue(setting, setting.value)
}

function draftValue(key: string) {
  const setting = data.value?.settings.find(item => item.key === key)
  if (!setting) return undefined
  return invalid(setting) || untouchedInexact(setting) ? setting.value : parsed(setting)
}

function gigabytes(bytes: number) {
  return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`
}

/** 按草稿中的两个磁盘参数计算新阈值，超过当前剩余空间时提示保存后会立即判定为磁盘不足。 */
const diskWarning = computed(() => {
  const disk = data.value?.disk
  const gb = draftValue('disk.min_free_gb')
  const percent = draftValue('disk.min_free_percent')
  if (!disk || gb === undefined || percent === undefined) return ''
  const threshold = Math.max(gb * 1024 ** 3, (percent / 100) * disk.totalBytes)
  return disk.freeBytes < threshold
    ? `当前数据盘剩余 ${gigabytes(disk.freeBytes)}，低于新阈值 ${gigabytes(threshold)}：保存后会立即判定为磁盘不足，执行容器拒绝运行命令，正在运行的命令会被终止。`
    : ''
})
const diskSummary = computed(() => {
  const disk = data.value?.disk
  if (!disk || !disk.totalBytes) return ''
  return `当前数据盘剩余 ${gigabytes(disk.freeBytes)}，共 ${gigabytes(disk.totalBytes)}（${Math.round((disk.freeBytes / disk.totalBytes) * 100)}%）。`
})

/** 保存前需要管理员确认的影响说明（方案第 5 节）。 */
function risks(setting: PlatformSetting): string[] {
  if (invalid(setting) || !changed(setting)) return []
  const value = parsed(setting)
  const items: string[] = []
  if (setting.lowerRisk && value < setting.value) items.push(setting.lowerRisk)
  if (setting.belowDefaultRisk && value < setting.defaultValue) items.push(setting.belowDefaultRisk)
  if (setting.raiseRisk && value > setting.value) items.push(setting.raiseRisk)
  if (setting.key.startsWith('disk.') && diskWarning.value) items.push(diskWarning.value)
  return items
}

function warnings(setting: PlatformSetting): string[] {
  return invalid(setting) ? [`请输入 ${setting.min}～${setting.max} 之间的整数`] : risks(setting)
}

const settingGroups = computed(() => (data.value?.groups ?? []).map(group => ({
  ...group,
  settings: (data.value?.settings ?? []).filter(setting => setting.group === group.id),
})))
const changes = computed(() => (data.value?.settings ?? []).filter(setting => setting.canEdit && changed(setting)))
const anyInvalid = computed(() => (data.value?.settings ?? []).some(setting => setting.canEdit && invalid(setting)))
const risky = computed(() => changes.value.some(setting => risks(setting).length > 0))
const pendingText = computed(() => {
  if (!canSave.value) return '需要“平台配置”修改权限'
  if (anyInvalid.value) return '有数值超出范围，修正后才能保存'
  return changes.value.length ? `有 ${changes.value.length} 项未保存的修改` : '没有未保存的修改'
})

const filteredEntries = computed(() => {
  const text = query.value.trim()
  return (data.value?.overview.entries ?? []).filter(entry =>
    (sourceFilter.value === 'all' || entry.source === sourceFilter.value)
    && (!text || entry.name.includes(text) || entry.where.includes(text)))
})
const entryGroups = computed(() => (Object.keys(groupTitles) as RuntimeParameterEntry['group'][])
  .map(group => ({ group, title: groupTitles[group], entries: filteredEntries.value.filter(entry => entry.group === group) }))
  .filter(group => group.entries.length > 0))
const sourceOptions = computed(() => {
  const text = query.value.trim()
  const matches = (data.value?.overview.entries ?? []).filter(entry => !text || entry.name.includes(text) || entry.where.includes(text))
  return [
    { value: 'all' as const, label: '全部', count: matches.length },
    ...(Object.keys(sourceLabels) as RuntimeParameterSource[]).map(source => ({
      value: source, label: sourceLabels[source], count: matches.filter(entry => entry.source === source).length,
    })),
  ]
})

function noEditText(entry: RuntimeParameterEntry) {
  if (!entry.owner) return entry.where
  return entry.owner.kind === 'platform-admin' ? '需要平台管理员' : `需要“${moduleLabels[entry.owner.module] ?? entry.owner.module}”修改权限`
}

function resetDrafts() {
  for (const setting of data.value?.settings ?? []) drafts[setting.key] = setting.exact ? String(setting.value) : ''
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await adminApi.getPlatformConfig()
    resetDrafts()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : '平台配置加载失败'
  } finally {
    loading.value = false
  }
}

function restoreDefault(setting: PlatformSetting) {
  drafts[setting.key] = String(setting.defaultValue)
  savedNotice.value = ''
}

function openConfirm() {
  if (!canSave.value || anyInvalid.value || !changes.value.length) return
  riskAcknowledged.value = false
  confirmOpen.value = true
}

async function confirmSave() {
  if (risky.value && !riskAcknowledged.value) return
  saving.value = true
  const count = changes.value.length
  try {
    await adminApi.savePlatformSettings(changes.value.map(setting => ({ key: setting.key, value: parsed(setting), revision: setting.revision })))
    confirmOpen.value = false
    await load()
    savedNotice.value = `已保存 ${count} 项，已写入审计记录。数值在各项标注的时机生效。`
  } catch (caught) {
    confirmOpen.value = false
    const message = caught instanceof Error ? caught.message : '保存失败'
    // 先重新读取最新值（会清空提示），再显示失败原因，避免 409 等失败被悄悄清掉。
    await load()
    error.value = `保存失败：${message}。页面已刷新为最新值，请确认后重新修改。`
  } finally {
    saving.value = false
  }
}

const tabs: Tab[] = ['settings', 'overview']

/** 页签支持左右方向键切换（WAI-ARIA tabs）。 */
function moveTab(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const next = tabs[(tabs.indexOf(tab.value) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!
  tab.value = next
  document.getElementById(`platform-config-tab-${next}`)?.focus()
}

function time(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''
}

onMounted(load)
</script>

<template>
  <div v-loading="loading" class="ops-page platform-config-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <div class="status-tabs" role="tablist" aria-label="平台配置视图" @keydown="moveTab">
      <button
        id="platform-config-tab-settings" class="status-tab" :class="{ active: tab === 'settings' }" type="button" role="tab"
        :aria-selected="tab === 'settings'" aria-controls="platform-config-panel-settings" :tabindex="tab === 'settings' ? 0 : -1" @click="tab = 'settings'"
      >配置</button>
      <button
        id="platform-config-tab-overview" class="status-tab" :class="{ active: tab === 'overview' }" type="button" role="tab"
        :aria-selected="tab === 'overview'" aria-controls="platform-config-panel-overview" :tabindex="tab === 'overview' ? 0 : -1" @click="tab = 'overview'"
      >总览</button>
    </div>

    <div v-if="data && tab === 'settings'" id="platform-config-panel-settings" class="platform-config-panel" role="tabpanel" aria-labelledby="platform-config-tab-settings">
      <el-alert v-if="!canSave" type="info" :closable="false" show-icon title="你可以查看平台配置；修改需要“平台配置”修改权限。" />
      <el-alert v-else-if="hasLockedItems" type="info" :closable="false" show-icon title="标注“只有平台管理员能保存”的安全类参数不能修改。" />
      <el-alert v-if="savedNotice" type="success" show-icon :title="savedNotice" @close="savedNotice = ''" />

      <section v-for="group in settingGroups" :key="group.id" class="content-panel parameter-group" :aria-labelledby="`parameter-group-${group.id}`">
        <header class="parameter-group__header">
          <h2 :id="`parameter-group-${group.id}`">{{ group.title }}</h2>
          <p>{{ group.description }}<template v-if="group.id === 'disk' && diskSummary"> {{ diskSummary }}</template></p>
        </header>
        <div v-for="setting in group.settings" :key="setting.key" class="parameter-row" :class="{ 'is-changed': changed(setting) }">
          <div class="parameter-row__text">
            <label :for="`parameter-${setting.key}`">{{ setting.label }}</label>
            <span v-if="setting.savePermission === 'platform-admin'" class="parameter-badge">只有平台管理员能保存</span>
            <span>{{ setting.description }}</span>
            <span v-if="!setting.available && setting.unavailableReason" class="parameter-unavailable">{{ setting.unavailableReason }}</span>
          </div>
          <div class="parameter-row__input">
            <el-input
              :id="`parameter-${setting.key}`"
              v-model="drafts[setting.key]"
              :disabled="!setting.canEdit"
              inputmode="numeric"
              :placeholder="setting.exact ? undefined : setting.actual"
              :aria-invalid="invalid(setting)"
              :aria-describedby="setting.canEdit && warnings(setting).length ? `parameter-warning-${setting.key}` : undefined"
              @input="savedNotice = ''"
            >
              <template #suffix>{{ setting.unit }}</template>
            </el-input>
          </div>
          <div class="parameter-row__meta">
            <span v-if="setting.storage === 'runtime'">范围 {{ setting.min }}～{{ setting.max }}</span>
            <span v-else>默认 {{ formatValue(setting, setting.defaultValue) }} · 范围 {{ setting.min }}～{{ setting.max }}</span>
            <span>生效：{{ setting.timing }}</span>
            <span v-if="!setting.exact">当前实际为 {{ setting.actual }}，不是整{{ setting.unit }}；需要修改时填写新值</span>
            <span v-if="setting.source === 'page' && setting.updatedBy && setting.updatedAt">{{ setting.updatedBy }} 于 {{ time(setting.updatedAt) }} 修改</span>
          </div>
          <div class="parameter-row__actions">
            <!-- Runtime 的容量与超时没有统一的系统默认值，不提供“恢复默认”。 -->
            <el-button v-if="setting.canEdit && setting.storage !== 'runtime' && (invalid(setting) || parsed(setting) !== setting.defaultValue)" size="small" @click="restoreDefault(setting)">恢复默认</el-button>
          </div>
          <p v-if="setting.canEdit && warnings(setting).length" :id="`parameter-warning-${setting.key}`" class="parameter-row__warning" role="note">{{ warnings(setting).join(' ') }}</p>
        </div>
      </section>

      <div class="content-panel parameter-footer">
        <span>{{ pendingText }}</span>
        <el-button :disabled="!changes.length" @click="resetDrafts">放弃修改</el-button>
        <el-button type="primary" :disabled="!canSave || anyInvalid || !changes.length" @click="openConfirm">保存</el-button>
      </div>
    </div>

    <div v-if="data && tab === 'overview'" id="platform-config-panel-overview" class="platform-config-panel" role="tabpanel" aria-labelledby="platform-config-tab-overview">
      <section class="content-panel" aria-labelledby="timeout-chains-title">
        <header class="parameter-group__header">
          <h2 id="timeout-chains-title">超时链路 · 实际生效</h2>
          <p>多层超时取最小值。每条链路标出实际生效的值和起限制作用的一项。</p>
        </header>
        <div class="timeout-chains" role="list" aria-label="超时链路">
          <div v-for="chain in data.overview.timeoutChains" :key="chain.id" class="timeout-chain" :class="{ 'is-warning': chain.warning }" role="listitem" :aria-label="chain.name">
            <strong>{{ chain.name }}</strong>
            <span class="timeout-chain__value">{{ chain.actual }}</span>
            <small>由“{{ chain.limiter }}”限制</small>
            <small v-for="layer in chain.layers" :key="layer" class="timeout-chain__layer">{{ layer }}</small>
            <small v-if="chain.warning" class="timeout-chain__warning">{{ chain.warning }}</small>
          </div>
        </div>
      </section>

      <div class="parameter-filters">
        <el-radio-group v-model="sourceFilter" aria-label="按来源筛选">
          <el-radio-button v-for="option in sourceOptions" :key="option.value" :value="option.value">{{ option.label }} {{ option.count }}</el-radio-button>
        </el-radio-group>
        <el-input v-model="query" class="parameter-filters__search" :prefix-icon="Search" clearable placeholder="参数名，如：超时" aria-label="搜索参数" />
      </div>

      <section v-for="group in entryGroups" :key="group.group" class="content-panel content-panel--flush" :aria-label="group.title">
        <header class="parameter-group__header parameter-group__header--table">
          <h2>{{ group.title }}</h2>
          <span>{{ group.entries.length }} 项</span>
        </header>
        <el-table :data="group.entries" row-key="id" class="parameter-table" table-layout="fixed">
          <el-table-column prop="name" label="参数" min-width="240" />
          <el-table-column label="当前值" min-width="200">
            <template #default="{ row }"><span class="parameter-table__value">{{ row.value }}</span></template>
          </el-table-column>
          <el-table-column label="来源" width="120">
            <template #default="{ row }"><span class="parameter-source" :class="`is-${row.source}`">{{ sourceLabels[row.source as RuntimeParameterSource] }}</span></template>
          </el-table-column>
          <el-table-column prop="timing" label="生效时机" min-width="200" />
          <el-table-column label="修改位置" min-width="200">
            <template #default="{ row }">
              <a v-if="row.canEdit && row.link === '/platform-config'" href="#" @click.prevent="tab = 'settings'">{{ row.where }} ›</a>
              <router-link v-else-if="row.canEdit && row.link" :to="row.link">{{ row.where }} ›</router-link>
              <span v-else class="parameter-muted">{{ noEditText(row) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
      <p v-if="!entryGroups.length" class="content-panel parameter-muted">没有符合条件的参数</p>
    </div>

    <el-dialog v-model="confirmOpen" :title="`确认保存 ${changes.length} 项修改`" width="560px">
      <p class="parameter-muted">修改按“平台配置”修改权限保存（安全类参数只限平台管理员），并逐项写入审计记录。</p>
      <ul class="parameter-changes" aria-label="待保存的修改">
        <li v-for="setting in changes" :key="setting.key">
          <div class="parameter-changes__line">
            <strong>{{ setting.label }}</strong>
            <span>{{ currentText(setting) }} → <strong>{{ formatValue(setting, drafts[setting.key] ?? '') }}</strong></span>
          </div>
          <small>生效：{{ setting.timing }}</small>
          <small v-for="item in risks(setting)" :key="item" class="parameter-row__warning">{{ item }}</small>
        </li>
      </ul>
      <el-checkbox v-if="risky" v-model="riskAcknowledged">我已了解上面标出的影响</el-checkbox>
      <template #footer>
        <el-button @click="confirmOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="risky && !riskAcknowledged" @click="confirmSave">确认保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.platform-config-page, .platform-config-panel { display: flex; flex-direction: column; gap: 14px; }
.parameter-group { padding: 0; }
.parameter-group__header { display: flex; flex-direction: column; gap: 2px; padding: 14px 20px; border-bottom: 1px solid var(--color-border); }
.parameter-group__header h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.parameter-group__header p, .parameter-group__header span { margin: 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.parameter-group__header--table { flex-direction: row; justify-content: space-between; align-items: center; }
.parameter-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 14px 20px; border-top: 1px solid var(--color-border); }
.parameter-row:first-of-type { border-top: 0; }
.parameter-row.is-changed { background: var(--color-primary-light); }
.parameter-row__text { display: flex; flex: 1 1 320px; flex-direction: column; gap: 3px; min-width: 0; }
.parameter-row__text label { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.parameter-badge { align-self: flex-start; padding: 1px 8px; border-radius: 6px; background: var(--color-bg-subtle); color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.parameter-row__text .parameter-unavailable { color: var(--color-warning-strong); }
.parameter-row__text span, .parameter-row__meta { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.parameter-row__input { flex: 0 0 132px; }
.parameter-row__meta { display: flex; flex: 0 0 220px; flex-direction: column; gap: 2px; }
.parameter-row__actions { display: flex; flex: 0 0 88px; justify-content: flex-end; }
.parameter-row__warning { flex: 1 1 100%; margin: 0; padding: 6px 10px; border-radius: 8px; background: var(--color-warning-light); color: var(--color-warning-strong); font-size: var(--font-size-caption); }
.parameter-footer { display: flex; position: sticky; bottom: 0; justify-content: flex-end; align-items: center; gap: 12px; }
.parameter-footer > span { margin-right: auto; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.timeout-chains { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 16px 20px; }
.timeout-chain { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 10px; }
.timeout-chain.is-warning { border-color: var(--color-warning); background: var(--color-warning-light); }
.timeout-chain strong { color: var(--color-text-heading); }
.timeout-chain__value { color: var(--color-text-heading); font-size: var(--font-size-heading, 22px); font-weight: var(--font-weight-title); }
.timeout-chain small { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.timeout-chain .timeout-chain__warning { color: var(--color-warning-strong); }
.parameter-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.parameter-filters__search { width: 260px; margin-left: auto; }
.parameter-table__value { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.parameter-source { display: inline-block; padding: 2px 8px; border-radius: 6px; background: var(--color-bg-subtle); color: var(--color-text-secondary); font-size: var(--font-size-badge, 12px); }
.parameter-source.is-page { background: var(--color-primary-light); color: var(--color-primary); }
.parameter-source.is-env { background: var(--color-warning-light); color: var(--color-warning-strong); }
.parameter-muted { color: var(--color-text-secondary); }
.parameter-changes { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; padding: 0; list-style: none; }
.parameter-changes li { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: 8px; }
.parameter-changes__line { display: flex; justify-content: space-between; gap: 12px; }
</style>
