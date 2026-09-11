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
import { workbenchApi } from '@/api/client'
import type { Artifact, TeamMemberRole, WorkspaceAgentMember, WorkspaceFile, WorkspaceMember } from '@/types/domain'
import ConversationStarter from '@/components/ConversationStarter.vue'
import WorkspaceMemberDialog from '@/components/WorkspaceMemberDialog.vue'
import WorkspaceSessionHistory from '@/components/WorkspaceSessionHistory.vue'
import WorkspaceSettingsDialog from '@/components/WorkspaceSettingsDialog.vue'
import { WorkspaceInfoPanel } from '@dsh-work/workbench-components'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'
import { resolveCurrentUserRole } from '@/utils/member-roles'

type WorkspaceTab = 'conversation' | 'files' | 'artifacts'
/** 对话页签内的视图：新对话（默认）/ 历史对话（design §2.2）。 */
type ConversationView = 'new' | 'history'

/**
 * 当前操作人角色可由路由宿主注入（测试与后续服务端返回角色字段时使用）；
 * 缺省时按 utils/member-roles 的保守口径从空间负责人推导。
 */
const props = withDefaults(
  defineProps<{ currentUserRole?: TeamMemberRole | null }>(),
  { currentUserRole: undefined },
)

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const starterRef = ref<{
  useWorkspaceFile: (file: WorkspaceFile) => void
}>()
const tabButtonRefs = ref<HTMLButtonElement[]>([])
const panelCollapsed = ref(false)
const mobileInfoOpen = ref(false)
const uploadInput = ref<HTMLInputElement>()
const uploading = ref(false)

const memberDialogOpen = ref(false)
const settingsDialogOpen = ref(false)
const agentMembers = ref<WorkspaceAgentMember[]>([])
const workspaceMembers = ref<WorkspaceMember[]>([])
/** 服务端返回的调用者角色（负责人转交后不再等于创建者，不能靠姓名推断）。 */
const serverUserRole = ref<TeamMemberRole | null>(null)
/** 当前操作人可发起对话的 Agent 成员：与服务端 allowedActions 一致（只读成员为空）。 */
const startableAgentMemberIds = computed(() => agentMembers.value
  .filter(member => member.status === 'available' && member.allowedActions.includes('start_conversation'))
  .map(member => member.id))
const presetAgentMember = ref<WorkspaceAgentMember | null>(null)

const requestedTab = String(route.query.tab ?? 'conversation')
const activeTab = ref<WorkspaceTab>(
  ['conversation', 'files', 'artifacts'].includes(requestedTab)
    ? (requestedTab as WorkspaceTab)
    : 'conversation',
)
/** 默认新对话；`?view=history` 深链在空间对象就绪后由 watch 恢复（仅团队）。 */
const conversationView = ref<ConversationView>('new')
const conversationViews: Array<{ id: ConversationView; label: string }> = [
  { id: 'new', label: '新对话' },
  { id: 'history', label: '历史对话' },
]

const workspaceId = computed(() => String(route.params.id ?? ''))
const workspace = computed(() =>
  contentStore.workspaces.find((item) => item.id === workspaceId.value),
)
const isPersonal = computed(() => workspace.value?.type === 'personal')
const isTeam = computed(() => workspace.value?.type === 'team')
/**
 * 团队分支只在服务端返回归档状态时进入只读态；`/workspaces` 契约补齐前，
 * 缺省视为活动空间（不会影响个人空间）。
 */
const isArchived = computed(() => isTeam.value && workspace.value?.status === 'archived')
/**
 * 当前操作人的团队角色。优先采用 `GET /workspaces/:id/members` 返回的
 * `currentUserRole`（负责人转交后创建者不再是负责人，按姓名推断会失效）；
 * 名册未就绪或加载失败时才回退到「负责人姓名 == 当前用户姓名」的保守判断，
 * 其余一律 null，团队写入口不渲染（不臆造权限，不误开入口）。
 */
const currentUserRole = computed<TeamMemberRole | null>(() => {
  if (props.currentUserRole !== undefined) return props.currentUserRole
  // 优先采用服务端返回的角色：负责人转交后创建者不再是负责人，按姓名推断会让
  // 新负责人失去全部写入口、旧创建者被误判。仅在名册尚未加载完成/加载失败时
  // 才回退到「负责人姓名 == 当前用户姓名」的保守判断。
  if (serverUserRole.value !== null) return serverUserRole.value
  return resolveCurrentUserRole({
    workspaceType: workspace.value?.type,
    archived: isArchived.value,
    owner: workspace.value?.owner,
    userName: authStore.user.name,
  })
})
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

/**
 * 视图切换写入 `?view=history`（design §2.2）。只有团队空间渲染切换行：
 * 个人空间的 `conversationView` 恒为 `new`，既不渲染历史视图也不发历史请求（AC-23）。
 */
function setConversationView(view: ConversationView) {
  conversationView.value = view
  const query = { ...route.query }
  if (view === 'history') query.view = 'history'
  else delete query.view
  void router.replace({ query })
}

watch(
  () => [route.query.view, isTeam.value] as const,
  ([view, team]) => {
    conversationView.value = team && String(view ?? '') === 'history' ? 'history' : 'new'
  },
  { immediate: true },
)

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
  if (isTeam.value) setConversationView('new')
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

/**
 * Agent 成员列表只按既有 T4 接口加载，且严格限定团队空间：个人空间既不发
 * 请求也不渲染（AC-23）。
 */
async function loadAgentMembers(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  try {
    agentMembers.value = await workbenchApi.listWorkspaceAgentMembers(workspaceId)
  } catch (error) {
    agentMembers.value = []
    notifyActionFailure('加载 Agent 成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
  }
}

/**
 * 加载员工名册与服务端判定的调用者角色。团队成员均可读取；个人空间不请求
 * （AC-23）。名册同时用于成员弹窗与设置弹窗的转交候选项。
 */
async function loadWorkspaceMembers(workspaceId = workspace.value?.id ?? '') {
  if (!workspaceId || !isTeam.value) return
  try {
    const directory = await workbenchApi.listWorkspaceMembers(workspaceId)
    workspaceMembers.value = directory.items
    serverUserRole.value = directory.currentUserRole
  } catch (error) {
    workspaceMembers.value = []
    serverUserRole.value = null
    notifyActionFailure('加载员工成员', `工作空间“${workspace.value?.name ?? workspaceId}”`, error, '稍后刷新页面重试。')
  }
}

function startAgentConversation(agentMemberId: string) {
  const member = agentMembers.value.find(item => item.id === agentMemberId)
  if (!member) return
  presetAgentMember.value = member
  memberDialogOpen.value = false
  setConversationView('new')
  selectTab('conversation')
}

function refreshTeamMembers() {
  void loadAgentMembers()
  void loadWorkspaceMembers()
}

/**
 * 空间设置保存：1A 无名称/说明更新接口（见 T6 报告缺口），此处只给出明确
 * 反馈，不伪造成功，也不改动个人空间路径。
 */
function saveWorkspaceSettings() {
  ElMessage.warning('名称与说明的保存接口尚未开放，本次修改未提交。')
}

onMounted(() => {
  void contentStore.refresh()
})

/**
 * 空间详情依赖 Store 里的空间对象：解析结果可能是团队或个人。团队分支在
 * 对象就绪后再加载 Agent 成员；个人空间分支不产生任何新请求（AC-23）。
 */
watch(workspace, (value) => {
  presetAgentMember.value = null
  memberDialogOpen.value = false
  settingsDialogOpen.value = false
  agentMembers.value = []
  workspaceMembers.value = []
  serverUserRole.value = null
  if (value?.type === 'team') {
    void loadAgentMembers(value.id)
    void loadWorkspaceMembers(value.id)
  }
}, { immediate: true })
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
        <section
          v-show="activeTab === 'conversation'"
          id="workspace-panel-conversation"
          class="workspace-conversation-pane"
          role="tabpanel"
          aria-labelledby="workspace-tab-conversation"
        >
          <div
            v-if="isTeam"
            class="panel workspace-conversation-pane__viewbar"
            data-testid="conversation-view-switch"
            role="tablist"
            aria-label="对话视图"
          >
            <button
              v-for="view in conversationViews"
              :key="view.id"
              class="workspace-conversation-pane__view"
              :class="{ 'is-active': conversationView === view.id }"
              type="button"
              role="tab"
              :aria-selected="conversationView === view.id"
              @click="setConversationView(view.id)"
            >
              {{ view.label }}
            </button>
          </div>

          <div class="workspace-conversation-pane__body">
            <ConversationStarter
              v-show="conversationView === 'new'"
              ref="starterRef"
              embedded
              :workspace-id="workspace.id"
              :workspace-name="workspace.name"
              workspace-locked
              :title="`在“${workspace.name}”中开始对话`"
              :preset-agent-member="isTeam ? presetAgentMember : null"
              :startable-agent-member-ids="isTeam ? startableAgentMemberIds : []"
              :requires-agent-member="isTeam"
            />

            <WorkspaceSessionHistory
              v-if="isTeam && conversationView === 'history'"
              :workspace-id="workspace.id"
              :workspace-name="workspace.name"
              :can-start-conversation="startableAgentMemberIds.length > 0"
              @start-new="setConversationView('new')"
            />
          </div>
        </section>

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
        :current-user-role="currentUserRole"
        :agent-members="agentMembers"
        collapsible
        @collapse="panelCollapsed = true"
        @manage-members="memberDialogOpen = true"
        @open-settings="settingsDialogOpen = true"
        @start-agent-conversation="startAgentConversation"
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
        :current-user-role="currentUserRole"
        :agent-members="agentMembers"
        @manage-members="memberDialogOpen = true"
        @open-settings="settingsDialogOpen = true"
        @start-agent-conversation="startAgentConversation"
      />
    </el-drawer>

    <template v-if="isTeam">
      <WorkspaceMemberDialog
        v-model:open="memberDialogOpen"
        :workspace-id="workspace.id"
        :workspace-name="workspace.name"
        :current-user-role="currentUserRole"
        :members="workspaceMembers"
        :agent-members="agentMembers"
        :load-agent-members="false"
        @refresh="refreshTeamMembers"
        @start-conversation="startAgentConversation"
      />

      <WorkspaceSettingsDialog
        v-model:open="settingsDialogOpen"
        :workspace-id="workspace.id"
        :workspace-name="workspace.name"
        :workspace-description="workspace.description"
        :current-user-role="currentUserRole"
        :members="workspaceMembers"
        save-warning="名称与说明的保存接口尚未就绪，本次修改不会提交到服务端。"
        @save="saveWorkspaceSettings"
        @transferred="refreshTeamMembers"
        @exited="router.push('/workspaces')"
      />
    </template>

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

.workspace-conversation-pane {
  display: flex;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: #fff;
}

.workspace-conversation-pane__viewbar {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  margin: 12px 20px 0;
  padding: 4px;
  border-radius: 10px;
  box-shadow: none;
}

.workspace-conversation-pane__view {
  display: inline-flex;
  min-width: 92px;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  color: #626762;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
  transition: color 140ms ease, background 140ms ease;
}

.workspace-conversation-pane__view:hover {
  color: #244d40;
  background: #f0f5f2;
}

.workspace-conversation-pane__view:focus-visible {
  outline: 2px solid #7bb8a6;
  outline-offset: -2px;
}

.workspace-conversation-pane__view.is-active {
  color: #1c5f4a;
  background: #e8f4ef;
  font-weight: 650;
}

.workspace-conversation-pane__body {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
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

  .workspace-conversation-pane__viewbar {
    margin: 10px 14px 0;
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
