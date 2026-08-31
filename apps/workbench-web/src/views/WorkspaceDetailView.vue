<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  ArrowRight,
  ChatDotRound,
  Document,
  Files,
  InfoFilled,
  Plus,
} from '@element-plus/icons-vue'

import { ArtifactCard } from '@dsh-work/ui-core'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { Artifact, WorkspaceFile } from '@/types/domain'
import ConversationStarter from '@/components/ConversationStarter.vue'
import { WorkspaceInfoPanel } from '@dsh-work/workbench-components'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

type WorkspaceTab = 'conversation' | 'files' | 'artifacts'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const starterRef = ref<{ useWorkspaceFile: (file: WorkspaceFile) => void }>()
const tabButtonRefs = ref<HTMLButtonElement[]>([])
const panelCollapsed = ref(false)
const mobileInfoOpen = ref(false)
const uploadInput = ref<HTMLInputElement>()
const uploading = ref(false)

const requestedTab = String(route.query.tab ?? 'conversation')
const activeTab = ref<WorkspaceTab>(
  ['conversation', 'files', 'artifacts'].includes(requestedTab)
    ? (requestedTab as WorkspaceTab)
    : 'conversation',
)

const workspaceId = computed(() => String(route.params.id ?? ''))
const workspace = computed(() =>
  contentStore.workspaces.find((item) => item.id === workspaceId.value),
)
const isPersonal = computed(() => workspace.value?.type === 'personal')
const workspaceArtifacts = computed(() =>
  contentStore.artifacts.filter((artifact) => artifact.workspaceId === workspaceId.value),
)
const workspaceTabs = computed(() => [
  {
    id: 'conversation' as const,
    label: '对话',
    count: workspace.value?.sessionCount ?? 0,
    icon: ChatDotRound,
  },
  {
    id: 'files' as const,
    label: isPersonal.value ? '文件' : '共享文件',
    count: workspace.value?.files.length ?? 0,
    icon: Files,
  },
  {
    id: 'artifacts' as const,
    label: '成果',
    count: workspaceArtifacts.value.length,
    icon: Document,
  },
])

function selectTab(tab: WorkspaceTab) {
  activeTab.value = tab
  const query = { ...route.query }
  if (tab === 'conversation') delete query.tab
  else query.tab = tab
  void router.replace({ query })
}

function onTabKeydown(event: KeyboardEvent, index: number) {
  const keyTargets: Record<string, number> = {
    ArrowLeft: (index - 1 + workspaceTabs.value.length) % workspaceTabs.value.length,
    ArrowRight: (index + 1) % workspaceTabs.value.length,
    Home: 0,
    End: workspaceTabs.value.length - 1,
  }
  const targetIndex = keyTargets[event.key]
  if (targetIndex === undefined) return
  event.preventDefault()
  const target = workspaceTabs.value[targetIndex]
  if (!target) return
  selectTab(target.id)
  void nextTick(() => tabButtonRefs.value[targetIndex]?.focus())
}

function useWorkspaceFile(file: WorkspaceFile) {
  selectTab('conversation')
  mobileInfoOpen.value = false
  void nextTick(() => {
    starterRef.value?.useWorkspaceFile(file)
    ElMessage.success(`已将“${file.name}”带入新对话`)
  })
}

function uploadFile() {
  uploadInput.value?.click()
}

async function onUploadSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !workspace.value) return
  uploading.value = true
  try {
    await contentStore.uploadWorkspaceFile(workspace.value.id, file)
    ElMessage.success(`已上传“${file.name}”并通过基础安全门禁`)
  } catch (error) {
    notifyActionFailure('文件上传', `工作空间“${workspace.value.name}”中的文件“${file.name}”`, error, '按支持的格式和 20 MB 限制调整文件后重新上传。')
  } finally {
    uploading.value = false
    input.value = ''
  }
}

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

watch(
  () => route.query.tab,
  (tab) => {
    const value = String(tab ?? 'conversation')
    if (['conversation', 'files', 'artifacts'].includes(value)) {
      activeTab.value = value as WorkspaceTab
    }
  },
)

onMounted(() => {
  void contentStore.refresh()
})
</script>

<template>
  <div v-if="contentStore.loading && !workspace" class="workspace-context-state">
    <el-skeleton :rows="8" animated />
  </div>

  <el-result
    v-else-if="!workspace"
    icon="warning"
    title="工作空间不存在或你没有访问权限"
    sub-title="请返回工作空间列表重新选择。"
  >
    <template #extra>
      <el-button type="primary" @click="router.push('/workspaces')">返回工作空间</el-button>
    </template>
  </el-result>

  <div
    v-else
    class="workspace-context-page"
    :class="{ 'workspace-context-page--collapsed': panelCollapsed }"
  >
    <main class="workspace-context-page__main">
      <header class="workspace-context-page__header">
        <nav class="workspace-context-tabs" role="tablist" aria-label="工作空间内容">
          <button
            v-for="(tab, index) in workspaceTabs"
            :id="`workspace-tab-${tab.id}`"
            :key="tab.id"
            ref="tabButtonRefs"
            class="workspace-context-tabs__item"
            :class="{ 'is-active': activeTab === tab.id }"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.id"
            :aria-controls="`workspace-panel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="selectTab(tab.id)"
            @keydown="onTabKeydown($event, index)"
          >
            <el-icon><component :is="tab.icon" /></el-icon>
            <span>{{ tab.label }}</span>
            <small>{{ tab.count }}</small>
          </button>
        </nav>

        <div class="workspace-context-page__header-actions">
          <button
            v-if="panelCollapsed"
            class="workspace-context-page__panel-open"
            type="button"
            aria-label="展开工作空间信息"
            @click="panelCollapsed = false"
          >
            <el-icon><InfoFilled /></el-icon>
            <span>空间信息</span>
            <el-icon><ArrowRight /></el-icon>
          </button>

          <button
            class="workspace-context-page__mobile-info"
            type="button"
            aria-label="查看工作空间信息"
            @click="mobileInfoOpen = true"
          >
            <el-icon><InfoFilled /></el-icon>
            <span>空间信息</span>
          </button>
        </div>
      </header>

      <div class="workspace-context-page__content">
        <ConversationStarter
          v-show="activeTab === 'conversation'"
          id="workspace-panel-conversation"
          ref="starterRef"
          embedded
          role="tabpanel"
          aria-labelledby="workspace-tab-conversation"
          :workspace-id="workspace.id"
          :workspace-name="workspace.name"
          workspace-locked
          :title="`在“${workspace.name}”中开始对话`"
        />

        <section
          v-if="activeTab === 'files'"
          id="workspace-panel-files"
          class="workspace-tab-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-files"
        >
          <header class="workspace-tab-pane__header">
            <div>
              <span class="workspace-tab-pane__eyebrow">{{ isPersonal ? '个人资料' : '团队资源' }}</span>
              <h1>{{ isPersonal ? '文件' : '共享文件' }}</h1>
              <p>{{ isPersonal ? '管理仅你可访问的资料，并将指定文件直接引用到新对话。' : '查看团队在当前工作空间共享的资料，并将指定文件直接引用到新对话。' }}</p>
            </div>
            <el-button type="primary" :icon="Plus" :loading="uploading" @click="uploadFile">上传文件</el-button>
            <input ref="uploadInput" class="visually-hidden" type="file" accept=".pdf,.docx,.xlsx,.csv,.txt,.md" @change="onUploadSelected" />
          </header>

          <div v-if="workspace.files.length" class="workspace-file-list panel">
            <article v-for="file in workspace.files" :key="file.id" class="workspace-file-row">
              <span class="workspace-file-row__icon"><el-icon><Files /></el-icon></span>
              <div class="workspace-file-row__copy">
                <strong>{{ file.name }}</strong>
                <span>{{ file.size }} · {{ file.uploadedBy }}上传 · {{ file.uploadedAt }}</span>
              </div>
              <span class="workspace-file-row__type">{{ file.type }}</span>
              <el-button plain @click="useWorkspaceFile(file)">引用到对话</el-button>
            </article>
          </div>

          <el-empty v-else :description="isPersonal ? '我的空间暂无文件' : '当前工作空间暂无共享文件'">
            <el-button type="primary" :icon="Plus" @click="uploadFile">上传第一个文件</el-button>
          </el-empty>
        </section>

        <section
          v-if="activeTab === 'artifacts'"
          id="workspace-panel-artifacts"
          class="workspace-tab-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-artifacts"
        >
          <header class="workspace-tab-pane__header">
            <div>
              <span class="workspace-tab-pane__eyebrow">成果文件</span>
              <h1>成果</h1>
              <p>集中查看当前工作空间内生成的报告、表格和分析文件，并追溯来源运行。</p>
            </div>
            <span class="workspace-tab-pane__count">{{ workspaceArtifacts.length }} 个已加载成果</span>
          </header>

          <div v-if="workspaceArtifacts.length" class="workspace-artifact-grid">
            <ArtifactCard
              v-for="artifact in workspaceArtifacts"
              :key="artifact.id"
              :artifact="artifact"
              @download="download(artifact)"
            />
          </div>
          <el-empty v-else description="当前工作空间暂无成果文件" />
        </section>
      </div>
    </main>

    <aside v-if="!panelCollapsed" class="workspace-context-page__aside">
      <WorkspaceInfoPanel
        :workspace="workspace"
        :data-scopes="authStore.user.dataScopes"
        collapsible
        @collapse="panelCollapsed = true"
      />
    </aside>

    <el-drawer
      v-model="mobileInfoOpen"
      class="workspace-context-drawer"
      direction="rtl"
      size="min(360px, 100vw)"
      :with-header="false"
    >
      <WorkspaceInfoPanel
        :workspace="workspace"
        :data-scopes="authStore.user.dataScopes"
      />
    </el-drawer>

  </div>
</template>

<style scoped>
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.workspace-context-state {
  min-height: 100vh;
  padding: 80px 10%;
  background: #fff;
}

.workspace-context-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  height: 100vh;
  overflow: hidden;
  background: #fff;
}

.workspace-context-page--collapsed {
  grid-template-columns: minmax(0, 1fr);
}

.workspace-context-page__main {
  display: flex;
  min-width: 0;
  height: 100vh;
  flex-direction: column;
  overflow: hidden;
}

.workspace-context-page__header {
  position: relative;
  z-index: 6;
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  border-bottom: 1px solid #e5e7e4;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 4px 18px rgb(31 40 35 / 3%);
  backdrop-filter: blur(10px);
}

.workspace-context-page__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 0 18px 0 8px;
}

.workspace-context-page__panel-open,
.workspace-context-page__mobile-info {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  gap: 6px;
  padding: 0 9px;
  border: 1px solid #e3e5e2;
  border-radius: 8px;
  color: #626762;
  background: #fff;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.workspace-context-page__panel-open:hover,
.workspace-context-page__mobile-info:hover {
  border-color: #cbd5d0;
  color: #244d40;
  background: #f8fbf9;
}

.workspace-context-page__mobile-info {
  display: none;
}

.workspace-context-tabs {
  display: flex;
  min-width: 0;
  height: 52px;
  flex: 1;
  align-items: stretch;
  gap: 3px;
  padding: 0 18px;
  overflow-x: auto;
  scrollbar-width: none;
}

.workspace-context-tabs::-webkit-scrollbar {
  display: none;
}

.workspace-context-tabs__item {
  position: relative;
  display: inline-flex;
  min-width: 118px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0 13px;
  border: 0;
  color: #777c77;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-caption);
  transition: color 140ms ease, background 140ms ease;
}

.workspace-context-tabs__item::after {
  position: absolute;
  right: 12px;
  bottom: -1px;
  left: 12px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  content: '';
}

.workspace-context-tabs__item:hover {
  color: #2b3b35;
  background: #f7f9f7;
}

.workspace-context-tabs__item:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -3px;
  border-radius: 8px 8px 0 0;
}

.workspace-context-tabs__item.is-active {
  color: #205f4d;
  font-weight: 650;
}

.workspace-context-tabs__item.is-active::after {
  background: #2e8b70;
}

.workspace-context-tabs__item .el-icon {
  font-size: var(--dsh-font-size-subheading);
}

.workspace-context-tabs__item small {
  min-width: 20px;
  padding: 2px 5px;
  border-radius: 999px;
  color: #8b908c;
  background: #f0f2ef;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.workspace-context-tabs__item.is-active small {
  color: #296c59;
  background: #e8f4ef;
}

.workspace-context-page__content {
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: #fff;
}

.workspace-context-page__aside {
  min-width: 0;
  height: 100vh;
  overflow: hidden;
  border-left: 1px solid #e5e7e4;
  box-shadow: -8px 0 28px rgb(32 42 36 / 3%);
}

.workspace-tab-pane {
  width: 100%;
  height: 100%;
  padding: 30px 32px 48px;
  overflow-y: auto;
  background: #f8faf8;
}

.workspace-tab-pane__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  gap: 24px;
  margin-bottom: 20px;
}

.workspace-tab-pane__eyebrow {
  color: #2d8068;
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  letter-spacing: 0.1em;
}

.workspace-tab-pane__header h1 {
  margin: 5px 0 0;
  color: #202420;
  font-size: var(--dsh-font-size-page-title);
  font-weight: 680;
  letter-spacing: -0.025em;
}

.workspace-tab-pane__header p {
  margin: 7px 0 0;
  color: #737a75;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.workspace-tab-pane__count {
  flex: 0 0 auto;
  padding-bottom: 4px;
  color: #8b918c;
  font-size: var(--dsh-font-size-badge);
}

.workspace-file-list {
  width: 100%;
  overflow: hidden;
  box-shadow: none;
}

.workspace-file-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 64px auto;
  align-items: center;
  gap: 13px;
  min-height: 74px;
  padding: 12px 15px;
  border-bottom: 1px solid #e8ebe8;
  background: #fff;
}

.workspace-file-row:last-child {
  border-bottom: 0;
}

.workspace-file-row__icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 10px;
  color: #23715b;
  background: #eaf6f1;
  font-size: var(--dsh-font-size-section);
}

.workspace-file-row__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-file-row__copy strong {
  overflow: hidden;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-row__copy span {
  margin-top: 5px;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
}

.workspace-file-row__type {
  justify-self: center;
  padding: 3px 7px;
  border-radius: 5px;
  color: #66706b;
  background: #f0f2f0;
  font-size: var(--dsh-font-size-micro);
  font-weight: 700;
}

.workspace-artifact-grid {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(390px, 1fr));
  gap: 12px;
}

:deep(.workspace-context-drawer .el-drawer__body) {
  padding: 0;
}

@media (max-width: 1180px) {
  .workspace-context-page,
  .workspace-context-page--collapsed {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace-context-page__aside,
  .workspace-context-page__panel-open {
    display: none;
  }

  .workspace-context-page__mobile-info {
    display: inline-flex;
  }
}

@media (max-width: 640px) {
  .workspace-context-tabs {
    padding: 0 8px;
  }

  .workspace-context-page__header-actions {
    padding-right: 10px;
    padding-left: 4px;
  }

  .workspace-context-tabs__item {
    min-width: 104px;
    padding: 0 8px;
  }

  .workspace-tab-pane {
    padding: 24px 14px 38px;
  }

  .workspace-tab-pane__header {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .workspace-file-row {
    grid-template-columns: 42px minmax(0, 1fr) auto;
  }

  .workspace-file-row__type {
    display: none;
  }

  .workspace-file-row .el-button {
    grid-column: 2 / -1;
    justify-self: start;
  }

  .workspace-artifact-grid {
    grid-template-columns: 1fr;
  }

}

@media (max-width: 520px) {
  .workspace-context-page__mobile-info span {
    display: none;
  }

  .workspace-context-page__mobile-info {
    width: 30px;
    padding: 0;
    justify-content: center;
  }

  .workspace-context-tabs__item small {
    display: none;
  }
}
</style>
