<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowRight,
  Close,
  DataAnalysis,
  Document,
  DocumentChecked,
  Files,
  Reading,
  Search,
  TrendCharts,
  Warning,
} from '@element-plus/icons-vue'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useTaskStore } from '@/stores/tasks'

const props = withDefaults(
  defineProps<{
    workspaceId?: string
    workspaceName?: string
    workspaceLocked?: boolean
    embedded?: boolean
    showActivity?: boolean
    title?: string
  }>(),
  {
    workspaceId: 'standalone',
    workspaceName: '未加入工作空间',
    workspaceLocked: false,
    embedded: false,
    showActivity: true,
    title: 'dsh-work，我帮你',
  },
)

const router = useRouter()
const taskStore = useTaskStore()
const rootRef = ref<HTMLElement>()

const selectedMode = ref('office')
const selectedCapability = ref('')
const presetPrompt = ref('')
const composerKey = ref(0)
const activityVisible = ref(true)

const workModes = [
  {
    id: 'office',
    label: '日常办公',
    description: '整理文档、查询制度和形成可交付报告',
  },
  {
    id: 'query',
    label: '企业查询',
    description: '在授权范围内查询 ERP、MES 和企业知识',
  },
  {
    id: 'analysis',
    label: '数据分析',
    description: '分析业务数据、上传文件并识别风险',
  },
]

const capabilities = [
  {
    label: '文档处理',
    icon: Document,
    modes: ['office'],
    prompt: '请整理我接下来提供的业务材料，提炼关键事实、待办事项和责任人。',
  },
  {
    label: '企业知识',
    icon: Reading,
    modes: ['office', 'query'],
    prompt: '查询公司现行制度中与委外加工发料和库存扣减有关的规定，并列出依据。',
  },
  {
    label: '订单进度',
    icon: Search,
    modes: ['query'],
    prompt: '查询订单 SO20260821001 当前生产进度，并说明是否能按期交付。',
  },
  {
    label: '生产进度',
    icon: TrendCharts,
    modes: ['query', 'analysis'],
    prompt: '汇总本周生产计划的执行进度，标出延期工单、影响因素和责任环节。',
  },
  {
    label: '库存分析',
    icon: Warning,
    modes: ['analysis'],
    prompt: '结合本周生产计划、当前库存和采购到货计划，识别未来 7 天的缺料风险。',
  },
  {
    label: '文件分析',
    icon: Files,
    modes: ['office', 'analysis'],
    prompt: '分析我上传的文件，概括主要指标、异常项和需要跟进的问题。',
  },
  {
    label: '经营分析',
    icon: DataAnalysis,
    modes: ['analysis'],
    prompt: '分析本月供应链经营数据，对比上月变化，找出影响交付的主要因素。',
  },
  {
    label: '报告生成',
    icon: DocumentChecked,
    modes: ['office', 'analysis'],
    prompt: '根据当前数据生成一份管理层可阅读的经营分析报告，包含摘要、风险和行动建议。',
  },
]

const orderedCapabilities = computed(() => {
  return [...capabilities].sort((left, right) => {
    const leftRelevant = left.modes.includes(selectedMode.value) ? 0 : 1
    const rightRelevant = right.modes.includes(selectedMode.value) ? 0 : 1
    return leftRelevant - rightRelevant
  })
})

const selectedModeDescription = computed(
  () => workModes.find((mode) => mode.id === selectedMode.value)?.description ?? '',
)
const currentActivity = computed(() => taskStore.activeTasks[0])
const activityStatusLabel = computed(() => {
  if (!currentActivity.value) return '就绪'
  if (currentActivity.value.status === 'awaiting_approval') return '待确认'
  if (currentActivity.value.status === 'queued') return '排队中'
  return '执行中'
})

function focusComposer() {
  void nextTick(() => rootRef.value?.querySelector<HTMLTextAreaElement>('.composer__input')?.focus())
}

function selectCapability(item: (typeof capabilities)[number]) {
  selectedCapability.value = item.label
  presetPrompt.value = item.prompt
  composerKey.value += 1
  focusComposer()
}

function useWorkspaceFile(name: string) {
  selectedMode.value = 'analysis'
  selectedCapability.value = '文件分析'
  presetPrompt.value = `请分析工作空间文件“${name}”，概括关键信息、异常项和需要跟进的问题。 @工作空间文件`
  composerKey.value += 1
  focusComposer()
}

function openActivity() {
  if (currentActivity.value) void router.push(`/conversations/${currentActivity.value.id}`)
  else void router.push('/workspaces')
}

function submitTask(payload: { prompt: string; files: string[]; workspaceId: string }) {
  const task = taskStore.createTask(
    payload.prompt,
    payload.files,
    payload.workspaceId,
    props.workspaceLocked ? props.workspaceName : undefined,
  )
  void router.push(`/conversations/${task.id}`)
}

defineExpose({ useWorkspaceFile })
</script>

<template>
  <div
    ref="rootRef"
    class="conversation-starter"
    :class="{ 'conversation-starter--embedded': embedded }"
  >
    <main class="workbench-stage">
      <section class="workbench-welcome" aria-labelledby="conversation-starter-title">
        <div class="workbench-welcome__copy">
          <h1 id="conversation-starter-title">{{ title }}</h1>
          <p>{{ selectedModeDescription }}</p>
        </div>

        <aside
          v-if="showActivity && activityVisible"
          class="activity-card"
          aria-label="当前活动"
        >
          <header>
            <span class="activity-card__label">
              <span
                class="activity-card__signal"
                :class="{ 'activity-card__signal--active': currentActivity }"
              ></span>
              活动
            </span>
            <button type="button" aria-label="关闭活动提示" @click="activityVisible = false">
              <el-icon><Close /></el-icon>
            </button>
          </header>
          <template v-if="taskStore.loading">
            <el-skeleton :rows="2" animated />
          </template>
          <template v-else>
            <strong>{{ currentActivity ? currentActivity.title : '企业工作上下文已就绪' }}</strong>
            <p v-if="currentActivity">
              {{ activityStatusLabel }} · {{ currentActivity.workspaceName }}
            </p>
            <p v-else>已注入身份、工作空间和默认数据权限</p>
            <button class="activity-card__action" type="button" @click="openActivity">
              {{ currentActivity ? '查看对话' : '查看空间' }}
              <el-icon><ArrowRight /></el-icon>
            </button>
          </template>
        </aside>

        <div class="work-modes" role="group" aria-label="选择工作模式">
          <button
            v-for="mode in workModes"
            :key="mode.id"
            type="button"
            :class="{ 'is-active': selectedMode === mode.id }"
            :aria-pressed="selectedMode === mode.id"
            @click="selectedMode = mode.id"
          >
            {{ mode.label }}
          </button>
        </div>

        <nav class="capability-strip" aria-label="常用能力">
          <button
            v-for="item in orderedCapabilities"
            :key="item.label"
            class="capability-chip"
            :class="{
              'is-selected': selectedCapability === item.label,
              'is-secondary': !item.modes.includes(selectedMode),
            }"
            type="button"
            @click="selectCapability(item)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <TaskComposer
          :key="composerKey"
          class="workbench-composer"
          :initial-prompt="presetPrompt"
          :initial-workspace-id="workspaceId"
          :initial-workspace-name="workspaceName"
          :workspace-locked="workspaceLocked"
          @submit="submitTask"
        />

        <footer class="workbench-trust">
          <span><i></i> 原型接口已连接</span>
          <span>支持 PDF、DOCX、XLSX、CSV，单文件不超过 20 MB</span>
          <span>⌘ + 回车键发送</span>
        </footer>
      </section>
    </main>
  </div>
</template>

<style scoped>
.conversation-starter {
  min-height: 100vh;
  overflow: hidden;
  color: #242624;
  background:
    radial-gradient(circle at 56% 42%, rgb(233 244 239 / 30%), transparent 31%),
    #fff;
}

.workbench-stage {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 78px 34px 116px;
}

.workbench-welcome {
  position: relative;
  width: min(100%, 860px);
  transform: translateY(-3vh);
}

.workbench-welcome__copy {
  text-align: center;
}

.workbench-welcome h1 {
  margin: 0;
  color: #1d1f1d;
  font-size: var(--dsh-font-size-hero);
  font-weight: 680;
  letter-spacing: -0.045em;
}

.workbench-welcome__copy p {
  min-height: 20px;
  margin: 9px 0 0;
  color: #858985;
  font-size: var(--dsh-font-size-caption);
}

.work-modes {
  display: flex;
  justify-content: center;
  gap: 3px;
  margin-top: 16px;
}

.work-modes button {
  min-height: 29px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  color: #666a66;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  transition: color 140ms ease, background 140ms ease;
}

.work-modes button:hover {
  color: #252725;
  background: #f0f1ef;
}

.work-modes button.is-active {
  color: #fff;
  background: #393c39;
}

.activity-card {
  position: absolute;
  top: -4px;
  right: 0;
  width: 190px;
  min-height: 120px;
  padding: 12px;
  border: 1px solid #dfe9e5;
  border-radius: 13px;
  background: #f0f7f4;
  box-shadow: 0 10px 28px rgb(40 68 57 / 5%);
}

.activity-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.activity-card header > button {
  display: grid;
  width: 21px;
  height: 21px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  color: #8a938f;
  background: transparent;
  cursor: pointer;
}

.activity-card header > button:hover {
  color: #3d4541;
  background: #e3eeea;
}

.activity-card__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #50605a;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.activity-card__signal {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #54b99a;
}

.activity-card__signal--active {
  box-shadow: 0 0 0 4px rgb(84 185 154 / 14%);
}

.activity-card > strong {
  display: -webkit-box;
  margin-top: 12px;
  overflow: hidden;
  color: #35413c;
  font-size: var(--dsh-font-size-caption);
  font-weight: 620;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.activity-card > p {
  margin: 5px 0 0;
  overflow: hidden;
  color: #7a8882;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-card__action {
  display: flex;
  align-items: center;
  width: max-content;
  min-height: 24px;
  gap: 4px;
  margin: 9px 0 0 auto;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  color: #365f52;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
}

.activity-card__action:hover {
  color: #164f3f;
  box-shadow: 0 2px 8px rgb(38 75 62 / 9%);
}

.capability-strip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 45px 0 8px;
  padding: 0 1px;
  overflow-x: auto;
  scrollbar-width: none;
}

.capability-strip::-webkit-scrollbar {
  display: none;
}

.capability-chip {
  display: inline-flex;
  min-height: 30px;
  flex: 0 0 auto;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px solid #e1e2df;
  border-radius: 999px;
  color: #5f645f;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
}

.capability-chip:hover {
  border-color: #bfc8c3;
  color: #263d35;
  background: #f6f9f7;
}

.capability-chip.is-selected {
  border-color: #9fc8ba;
  color: #155e4b;
  background: #edf7f3;
}

.capability-chip.is-secondary {
  color: #909490;
}

.capability-chip .el-icon {
  font-size: var(--dsh-font-size-body);
}

.workbench-composer {
  width: 100%;
}

.workbench-trust {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  margin-top: 10px;
  color: #999d99;
  font-size: var(--dsh-font-size-micro);
}

.workbench-trust span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.workbench-trust i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #58b397;
}

.conversation-starter--embedded .workbench-stage {
  min-height: 100%;
  height: 100%;
  padding-right: 28px;
  padding-left: 28px;
}

.conversation-starter--embedded {
  min-height: 100%;
  height: 100%;
}

.conversation-starter--embedded .workbench-welcome {
  transform: translateY(-1.5vh);
}

@media (max-width: 1020px) {
  .activity-card {
    position: relative;
    top: auto;
    right: auto;
    width: min(100%, 360px);
    min-height: auto;
    margin: 20px auto 0;
  }

  .capability-strip {
    margin-top: 24px;
  }
}

@media (max-width: 640px) {
  .workbench-stage,
  .conversation-starter--embedded .workbench-stage {
    align-items: flex-start;
    padding: 88px 14px 64px;
  }

  .workbench-welcome,
  .conversation-starter--embedded .workbench-welcome {
    transform: none;
  }

  .workbench-welcome h1 {
    font-size: var(--dsh-font-size-metric);
  }

  .workbench-welcome__copy p {
    padding: 0 22px;
    line-height: 1.55;
  }

  .work-modes {
    margin-top: 13px;
  }

  .work-modes button {
    padding: 0 9px;
  }

  .capability-strip {
    margin-right: -14px;
    margin-left: -14px;
    padding: 0 14px;
  }

  .workbench-trust {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    padding: 0 8px;
  }
}
</style>
