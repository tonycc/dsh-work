<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  Document,
  DocumentChecked,
  Files,
  Reading,
} from '@element-plus/icons-vue'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { WorkspaceFile } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const props = withDefaults(
  defineProps<{
    workspaceId?: string
    workspaceName?: string
    workspaceLocked?: boolean
    embedded?: boolean
    title?: string
  }>(),
  {
    workspaceId: '',
    workspaceName: '',
    workspaceLocked: false,
    embedded: false,
    title: 'dsh-work，我帮你',
  },
)

const router = useRouter()
const taskStore = useTaskStore()
const contentStore = useContentStore()
const rootRef = ref<HTMLElement>()
const workspaceLoadFinished = ref(false)

const selectedTask = ref('')
const presetPrompt = ref('')
const composerKey = ref(0)
const referencedWorkspaceFileIds = ref<string[]>([])

const personalWorkspace = computed(() =>
  contentStore.workspaces.find(workspace => workspace.type === 'personal'),
)
const selectedWorkspace = computed(() => {
  if (props.workspaceLocked) {
    return contentStore.workspaces.find(workspace => workspace.id === props.workspaceId)
  }
  return personalWorkspace.value ?? contentStore.workspaces[0]
})
const composerWorkspaceId = computed(() =>
  props.workspaceLocked ? props.workspaceId : (selectedWorkspace.value?.id ?? ''),
)
const composerWorkspaceName = computed(() =>
  props.workspaceLocked ? props.workspaceName : (selectedWorkspace.value?.name ?? '我的空间'),
)
const composerReady = computed(() =>
  props.workspaceLocked || contentStore.initialized || workspaceLoadFinished.value,
)

const commonTasks = [
  {
    label: '整理文档',
    icon: Document,
    prompt: '请整理我接下来提供的业务材料，提炼关键事实、待办事项和责任人。',
  },
  {
    label: '查询制度',
    icon: Reading,
    prompt: '查询公司现行制度中与委外加工发料和库存扣减有关的规定，并列出依据。',
  },
  {
    label: '分析文件',
    icon: Files,
    prompt: '分析我上传的文件，概括主要指标、异常项和需要跟进的问题。',
  },
  {
    label: '生成报告',
    icon: DocumentChecked,
    prompt: '根据当前数据生成一份管理层可阅读的经营分析报告，包含摘要、风险和行动建议。',
  },
]

function focusComposer() {
  void nextTick(() => rootRef.value?.querySelector<HTMLTextAreaElement>('.composer__input')?.focus())
}

function selectTask(item: (typeof commonTasks)[number]) {
  selectedTask.value = item.label
  referencedWorkspaceFileIds.value = []
  presetPrompt.value = item.prompt
  composerKey.value += 1
  focusComposer()
}

function useWorkspaceFile(file: WorkspaceFile) {
  selectedTask.value = '分析文件'
  referencedWorkspaceFileIds.value = [file.id]
  presetPrompt.value = `请分析工作空间文件“${file.name}”，概括关键信息、异常项和需要跟进的问题。 @工作空间文件`
  composerKey.value += 1
  focusComposer()
}

async function submitTask(payload: { prompt: string; files: File[]; workspaceId: string }) {
  try {
    const task = await taskStore.createTask(
      payload.prompt,
      payload.files,
      payload.workspaceId,
      props.workspaceLocked ? props.workspaceName : composerWorkspaceName.value,
      undefined,
      referencedWorkspaceFileIds.value,
    )
    referencedWorkspaceFileIds.value = []
    await router.push(`/conversations/${task.id}`)
  } catch (error) {
    notifyActionFailure('创建对话', props.workspaceLocked ? `工作空间“${props.workspaceName}”` : '新对话', error, '检查 Agent、工作空间、附件和输入内容后重新提交。')
  }
}

onMounted(async () => {
  if (props.workspaceLocked) {
    workspaceLoadFinished.value = true
    return
  }
  try {
    await contentStore.load()
  } catch (error) {
    notifyActionFailure('加载工作空间', '新对话的空间列表', error, '仍可继续发送，服务端会自动归入“我的空间”。')
  } finally {
    workspaceLoadFinished.value = true
  }
})

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
          <p>整理文档、查询制度、分析文件并形成可交付报告</p>
        </div>

        <nav class="capability-strip" aria-label="常用任务">
          <button
            v-for="item in commonTasks"
            :key="item.label"
            class="capability-chip"
            :class="{ 'is-selected': selectedTask === item.label }"
            type="button"
            @click="selectTask(item)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
          </button>
        </nav>

        <TaskComposer
          v-if="composerReady"
          :key="composerKey"
          class="workbench-composer"
          :initial-prompt="presetPrompt"
          :initial-workspace-id="composerWorkspaceId"
          :initial-workspace-name="composerWorkspaceName"
          :workspaces="contentStore.workspaces"
          :workspace-locked="workspaceLocked"
          @submit="submitTask"
        />
        <el-skeleton v-else class="workbench-composer" :rows="3" animated />

        <footer class="workbench-trust">
          <span>支持 PDF、DOCX、XLSX、CSV，单文件不超过 20 MB</span>
          <span>Enter 发送 · Shift + Enter 换行</span>
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

.capability-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 22px 0 8px;
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

  .capability-strip {
    justify-content: flex-start;
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
