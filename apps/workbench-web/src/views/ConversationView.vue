<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  CircleCheck,
  Close,
  CopyDocument,
  DataLine,
  Document,
  Download,
  Lock,
  MoreFilled,
  RefreshRight,
  Share,
  VideoPause,
} from '@element-plus/icons-vue'

import { RunTimeline, StatusTag } from '@dsh-work/ui-core'
import { useTaskStore } from '@/stores/tasks'
import type { Artifact, TaskSource } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import { workbenchApi } from '@/api/client'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()

const detailsOpen = ref(false)
const previewArtifact = ref<Artifact>()
const previewOpen = ref(false)
const conversationScroll = ref<HTMLElement>()
const showJumpToLatest = ref(false)
const messageFeedback = ref<Record<string, 'up' | 'down'>>({})

const task = computed(() => taskStore.getTask(String(route.params.id)))
const canStop = computed(() => task.value && ['queued', 'running'].includes(task.value.status))
const canRetry = computed(() => task.value && ['failed', 'cancelled'].includes(task.value.status))
const currentStep = computed(() =>
  task.value?.steps.find((step) => ['running', 'awaiting_approval'].includes(step.status)),
)
const lastAssistantMessageId = computed(() =>
  [...(task.value?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id,
)

const sourceTypeLabels: Record<TaskSource['type'], string> = {
  knowledge: '企业知识',
  erp: '业务系统',
  mes: '生产系统',
  file: '上传文件',
}

function goBack() {
  if (window.history.length > 1) router.back()
  else void router.push('/workbench')
}

function scrollToBottom(behavior: 'auto' | 'smooth' = 'smooth') {
  const target = conversationScroll.value
  if (!target) return
  target.scrollTo({ top: target.scrollHeight, behavior })
  showJumpToLatest.value = false
}

function onConversationScroll() {
  const target = conversationScroll.value
  if (!target) return
  showJumpToLatest.value = target.scrollHeight - target.scrollTop - target.clientHeight > 180
}

async function stopCurrentRun() {
  if (!task.value) return
  try {
    await ElMessageBox.confirm(
      '停止后会终止本轮运行尝试，已有对话和执行记录仍会保留。',
      '停止本轮执行？',
      {
        confirmButtonText: '停止本轮执行',
        cancelButtonText: '继续等待',
        type: 'warning',
      },
    )
    await taskStore.cancelTask(task.value.id)
    ElMessage.success('本轮执行已停止，对话记录已保留')
  } catch {
    // User cancelled the confirmation.
  }
}

async function retryRun() {
  if (!task.value) return
  try {
    await taskStore.retryTask(task.value.id)
    ElMessage.success('已创建新的运行尝试')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重新执行失败')
  }
}

function approveRun() {
  if (!task.value) return
  taskStore.approveTask(task.value.id)
  ElMessage.success('已确认数据范围，正在继续回答')
}

async function rejectRun() {
  if (!task.value) return
  await taskStore.cancelTask(task.value.id)
  ElMessage.info('已拒绝本轮数据查询，你仍可继续提问')
}

function copyAnswer(content: string) {
  void navigator.clipboard.writeText(content)
  ElMessage.success('回答已复制')
}

function setFeedback(messageId: string, value: 'up' | 'down') {
  if (messageFeedback.value[messageId] === value) {
    delete messageFeedback.value[messageId]
    return
  }
  messageFeedback.value[messageId] = value
  ElMessage.success(value === 'up' ? '感谢反馈' : '已记录问题反馈')
}

function speakAnswer(content: string) {
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(content)
  utterance.lang = 'zh-CN'
  window.speechSynthesis.speak(utterance)
  ElMessage.success('开始朗读回答')
}

function copyConversationLink() {
  void navigator.clipboard.writeText(window.location.href)
  ElMessage.success('对话链接已复制')
}

function exportRun() {
  if (!task.value) return
  const content = task.value.messages
    .map((message) => `${message.role === 'user' ? '我' : 'dsh-work'}：${message.content}`)
    .join('\n\n')
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${task.value.title}-对话记录.txt`
  anchor.click()
  URL.revokeObjectURL(url)
  ElMessage.success('对话记录已导出')
}

function onMoreCommand(command: string | number | object) {
  const value = String(command)
  if (value === 'copy-link') copyConversationLink()
  if (value === 'export') exportRun()
}

function preview(item: Artifact) {
  previewArtifact.value = item
  previewOpen.value = true
}

function download(item: Artifact) {
  const anchor = document.createElement('a')
  anchor.href = workbenchApi.artifactDownloadUrl(item.id, item.version)
  anchor.download = item.name
  anchor.click()
  ElMessage.success('已开始下载真实成果文件')
}

async function submitFollowUp(payload: { prompt: string; files: string[]; workspaceId: string }) {
  if (!task.value) return
  try {
    const nextTask = await taskStore.sendMessage(task.value.id, payload.prompt, payload.files)
    if (nextTask) await router.replace(`/conversations/${nextTask.id}`)
    await nextTick(() => scrollToBottom())
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发送消息失败')
  }
}

async function initializeConversation() {
  await taskStore.load()
  await nextTick()
  scrollToBottom('auto')
}

onMounted(initializeConversation)

watch(
  [() => route.params.id, () => task.value?.messages.length, () => task.value?.status],
  async () => {
    await nextTick()
    if (!showJumpToLatest.value) scrollToBottom('smooth')
  },
)
</script>

<template>
  <div class="conversation-page">
    <div v-if="taskStore.loading && !task" class="conversation-state">
      <el-skeleton :rows="8" animated />
    </div>

    <el-result
      v-else-if="!task"
      class="conversation-state"
      icon="warning"
      title="未找到对话"
      sub-title="该对话可能已被删除，或当前角色无权访问。"
    >
      <template #extra>
        <el-button type="primary" @click="router.push('/workbench')">返回工作台</el-button>
      </template>
    </el-result>

    <template v-else>
      <header class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" aria-label="返回" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1>{{ task.title }}</h1>
        </div>
        <div class="conversation-header__actions">
          <StatusTag :status="task.status" dot />
          <el-button text :icon="DataLine" @click="detailsOpen = true">
            <span class="header-action-label">对话详情</span>
          </el-button>
          <el-button
            v-if="canStop"
            text
            :icon="VideoPause"
            aria-label="停止本轮执行"
            @click="stopCurrentRun"
          />
          <el-button
            v-if="canRetry"
            text
            :icon="RefreshRight"
            aria-label="重新执行本轮"
            @click="retryRun"
          />
          <el-dropdown @command="onMoreCommand">
            <el-button text :icon="MoreFilled" aria-label="更多对话操作" />
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="copy-link">
                  <el-icon><Share /></el-icon>
                  复制对话链接
                </el-dropdown-item>
                <el-dropdown-item command="export">
                  <el-icon><Download /></el-icon>
                  导出对话记录
                </el-dropdown-item>
                <el-dropdown-item disabled>移动到其他工作空间</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main
        ref="conversationScroll"
        class="conversation-scroll"
        aria-label="对话内容"
        @scroll.passive="onConversationScroll"
      >
        <div class="conversation-thread">
          <article
            v-for="message in task.messages"
            :key="message.id"
            class="conversation-message"
            :class="`conversation-message--${message.role}`"
          >
            <template v-if="message.role === 'user'">
              <div class="user-message">
                <p>{{ message.content }}</p>
                <time>{{ message.createdAt }}</time>
              </div>
            </template>

            <template v-else>
              <div class="assistant-identity">
                <span class="assistant-avatar">d</span>
                <div>
                  <strong>dsh-work</strong>
                  <span v-if="message.id === lastAssistantMessageId && task.status === 'succeeded'">
                    已完成{{ task.duration ? ` · ${task.duration}` : '' }}
                  </span>
                  <span v-else>{{ message.createdAt }}</span>
                </div>
              </div>

              <div class="assistant-answer">
                <p>{{ message.content }}</p>

                <div
                  v-if="message.id === lastAssistantMessageId && task.artifacts.length"
                  class="answer-artifacts"
                >
                  <button
                    v-for="artifact in task.artifacts"
                    :key="artifact.id"
                    type="button"
                    @click="preview(artifact)"
                  >
                    <span><el-icon><Document /></el-icon></span>
                    <span>
                      <strong>{{ artifact.name }}</strong>
                      <small>{{ artifact.size }} · V{{ artifact.version }}</small>
                    </span>
                    <el-icon><ArrowDown /></el-icon>
                  </button>
                </div>

                <div class="assistant-actions">
                  <button type="button" aria-label="复制回答" @click="copyAnswer(message.content)">
                    <el-icon><CopyDocument /></el-icon>
                  </button>
                  <button
                    type="button"
                    aria-label="回答有帮助"
                    :class="{ 'is-active': messageFeedback[message.id] === 'up' }"
                    @click="setFeedback(message.id, 'up')"
                  >
                    <span aria-hidden="true">♡</span>
                  </button>
                  <button
                    type="button"
                    aria-label="回答需要改进"
                    :class="{ 'is-active': messageFeedback[message.id] === 'down' }"
                    @click="setFeedback(message.id, 'down')"
                  >
                    <span aria-hidden="true">◇</span>
                  </button>
                  <button type="button" aria-label="朗读回答" @click="speakAnswer(message.content)">
                    <span aria-hidden="true">◖</span>
                  </button>
                  <button
                    type="button"
                    aria-label="复制对话链接"
                    @click="copyConversationLink"
                  >
                    <el-icon><Share /></el-icon>
                  </button>
                  <span class="assistant-run-meta">
                    {{ task.tokenUsage ? `${task.tokenUsage.toLocaleString()} Token` : '自动' }}
                    · {{ task.agentVersion.split('@')[0] }}
                  </span>
                </div>
              </div>
            </template>
          </article>

          <article
            v-if="['queued', 'running'].includes(task.status)"
            class="conversation-message conversation-message--assistant conversation-message--working"
          >
            <div class="assistant-identity">
              <span class="assistant-avatar">d</span>
              <div>
                <strong>dsh-work</strong>
                <span>正在处理</span>
              </div>
            </div>
            <div class="working-answer">
              <span class="working-dots"><i></i><i></i><i></i></span>
              <span>{{ currentStep?.title ?? '正在准备回答' }}</span>
              <button type="button" @click="detailsOpen = true">查看执行过程</button>
            </div>
          </article>

          <section v-if="task.status === 'awaiting_approval'" class="conversation-notice approval-notice">
            <span class="conversation-notice__icon"><el-icon><Lock /></el-icon></span>
            <div>
              <strong>继续回答前需要确认数据范围</strong>
              <p>本轮将只读查询工厂一范围内 42 张订单，不会修改任何业务数据。</p>
              <dl>
                <div><dt>工具</dt><dd class="mono">erp.get_order_materials</dd></div>
                <div><dt>范围</dt><dd>工厂一 · 当前用户授权</dd></div>
              </dl>
            </div>
            <div class="conversation-notice__actions">
              <el-button @click="rejectRun">拒绝</el-button>
              <el-button type="primary" @click="approveRun">确认并继续</el-button>
            </div>
          </section>

          <section v-if="task.error" class="conversation-notice error-notice">
            <span class="conversation-notice__icon"><el-icon><Close /></el-icon></span>
            <div>
              <strong>{{ task.error.message }}</strong>
              <p>{{ task.error.suggestion }}</p>
              <code>{{ task.error.code }}</code>
            </div>
            <el-button type="primary" plain :icon="RefreshRight" @click="retryRun">
              重新执行本轮
            </el-button>
          </section>

          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div class="conversation-composer-dock">
        <button
          v-if="showJumpToLatest"
          class="jump-latest"
          type="button"
          @click="scrollToBottom()"
        >
          回到最新消息
          <el-icon><ArrowDown /></el-icon>
        </button>
        <div class="conversation-composer-dock__inner">
          <TaskComposer compact @submit="submitFollowUp" />
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>

      <el-drawer
        v-model="detailsOpen"
        class="conversation-drawer"
        title="对话详情"
        size="420px"
      >
        <section class="drawer-section">
          <h2>当前执行</h2>
          <dl class="run-facts">
            <div><dt>工作空间</dt><dd>{{ task.workspaceName }}</dd></div>
            <div><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
            <div><dt>运行</dt><dd class="mono">{{ task.id }}</dd></div>
            <div><dt>Agent</dt><dd class="mono">{{ task.agentVersion }}</dd></div>
          </dl>
        </section>

        <section class="drawer-section">
          <h2>本轮执行步骤</h2>
          <RunTimeline :steps="task.steps" />
        </section>

        <section class="drawer-section">
          <h2>数据来源</h2>
          <div v-if="task.sources.length" class="source-list">
            <article v-for="source in task.sources" :key="source.id">
              <span>{{ sourceTypeLabels[source.type] }}</span>
              <strong>{{ source.title }}</strong>
              <p>{{ source.description }}</p>
            </article>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未产生来源记录" />
        </section>

        <section class="drawer-section">
          <h2>成果文件</h2>
          <div v-if="task.artifacts.length" class="drawer-artifacts">
            <button
              v-for="artifact in task.artifacts"
              :key="artifact.id"
              type="button"
              @click="preview(artifact)"
            >
              <el-icon><Document /></el-icon>
              <span><strong>{{ artifact.name }}</strong><small>{{ artifact.size }}</small></span>
            </button>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未生成成果" />
        </section>
      </el-drawer>

      <el-dialog
        v-model="previewOpen"
        width="min(720px, calc(100vw - 32px))"
        title="成果预览"
      >
        <div v-if="previewArtifact" class="artifact-preview">
          <span class="artifact-preview__icon"><el-icon><Document /></el-icon></span>
          <h3>{{ previewArtifact.name }}</h3>
          <p>{{ previewArtifact.summary }}</p>
          <dl>
            <div><dt>版本</dt><dd>V{{ previewArtifact.version }}</dd></div>
            <div><dt>大小</dt><dd>{{ previewArtifact.size }}</dd></div>
            <div><dt>来源运行</dt><dd class="mono">{{ previewArtifact.runId }}</dd></div>
          </dl>
          <div class="artifact-preview__placeholder">
            <el-icon><CircleCheck /></el-icon>
            原型已验证预览入口；真实版本将接入文件预览服务。
          </div>
        </div>
        <template #footer>
          <el-button @click="previewOpen = false">关闭</el-button>
          <el-button
            v-if="previewArtifact"
            type="primary"
            :icon="Download"
            @click="download(previewArtifact)"
          >
            下载
          </el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>

<style scoped>
.conversation-page {
  position: relative;
  height: 100vh;
  overflow: hidden;
  color: #242624;
  background: #fff;
}

.conversation-state {
  max-width: 860px;
  margin: 0 auto;
  padding: 120px 28px;
}

.conversation-header {
  position: absolute;
  z-index: 12;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  gap: 18px;
  padding: 0 22px;
  border-bottom: 1px solid rgb(234 235 232 / 75%);
  background: rgb(255 255 255 / 90%);
  backdrop-filter: blur(12px);
}

.conversation-header__left,
.conversation-header__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.conversation-header__left h1 {
  margin: 0;
  overflow: hidden;
  color: #242624;
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-header__back {
  display: grid;
  width: 31px;
  height: 31px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #686d68;
  background: transparent;
  cursor: pointer;
}

.conversation-header__back:hover {
  color: #222422;
  background: #f1f2f0;
}

.conversation-header__actions {
  flex: 0 0 auto;
}

.conversation-scroll {
  height: 100vh;
  padding: 94px 28px 226px;
  overflow-y: auto;
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
}

.conversation-thread {
  width: min(100%, 920px);
  min-height: calc(100vh - 330px);
  margin: 0 auto;
}

.conversation-message {
  width: 100%;
}

.conversation-message + .conversation-message {
  margin-top: 38px;
}

.conversation-message--user {
  display: flex;
  justify-content: flex-end;
  padding-left: 20%;
}

.user-message {
  max-width: 72%;
  color: #303330;
  text-align: right;
}

.user-message p {
  margin: 0;
  padding: 10px 14px;
  border-radius: 14px 14px 4px 14px;
  background: #f1f2f0;
  font-size: var(--dsh-font-size-body);
  line-height: 1.65;
  text-align: left;
  white-space: pre-wrap;
}

.user-message time {
  display: block;
  margin-top: 5px;
  color: #a0a39f;
  font-size: var(--dsh-font-size-micro);
}

.assistant-identity {
  display: flex;
  align-items: center;
  gap: 9px;
}

.assistant-avatar {
  display: grid;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #fff;
  background: #3e5f55;
  font-size: var(--dsh-font-size-body);
  font-weight: 750;
}

.assistant-identity > div {
  display: flex;
  flex-direction: column;
}

.assistant-identity strong {
  color: #292c29;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.assistant-identity span:not(.assistant-avatar) {
  margin-top: 2px;
  color: #9a9e9a;
  font-size: var(--dsh-font-size-micro);
}

.assistant-answer,
.working-answer {
  margin: 13px 0 0 34px;
}

.assistant-answer > p {
  margin: 0;
  color: #303430;
  font-size: var(--dsh-font-size-body);
  line-height: 1.9;
  white-space: pre-wrap;
}

.assistant-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 31px;
  margin-top: 13px;
  color: #888d88;
}

.assistant-actions button {
  display: grid;
  width: 27px;
  height: 27px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: #7e837e;
  background: transparent;
  cursor: pointer;
}

.assistant-actions button:hover,
.assistant-actions button.is-active {
  color: #175e4d;
  background: #eff6f3;
}

.assistant-run-meta {
  margin-left: 7px;
  color: #949994;
  font-size: var(--dsh-font-size-micro);
}

.answer-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.answer-artifacts button {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 16px;
  align-items: center;
  min-width: 230px;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #4c514c;
  background: #fafbfa;
  cursor: pointer;
  text-align: left;
}

.answer-artifacts button:hover {
  border-color: #bdcbc5;
  background: #f5f8f6;
}

.answer-artifacts button > span:first-child {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: #356858;
  background: #eaf4f0;
}

.answer-artifacts button > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.answer-artifacts strong {
  overflow: hidden;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.answer-artifacts small {
  margin-top: 3px;
  color: #939793;
  font-size: var(--dsh-font-size-micro);
}

.working-answer {
  display: flex;
  align-items: center;
  min-height: 42px;
  gap: 10px;
  color: #6e746f;
  font-size: var(--dsh-font-size-caption);
}

.working-answer > button {
  margin-left: auto;
  padding: 0;
  border: 0;
  color: #34705f;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.working-dots {
  display: flex;
  gap: 3px;
}

.working-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #67a997;
  animation: working-pulse 1s ease-in-out infinite;
}

.working-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.working-dots i:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes working-pulse {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }

  50% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

.conversation-notice {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  margin: 36px 0 0 34px;
  padding: 14px;
  border: 1px solid #efd7b1;
  border-radius: 12px;
  background: #fff9ef;
}

.conversation-notice__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  color: #9e5b12;
  background: #ffedcf;
}

.conversation-notice strong {
  font-size: var(--dsh-font-size-caption);
}

.conversation-notice p {
  margin: 5px 0 0;
  color: #767069;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
}

.conversation-notice dl {
  display: flex;
  gap: 20px;
  margin: 9px 0 0;
}

.conversation-notice dl div {
  display: flex;
  gap: 6px;
}

.conversation-notice dt,
.conversation-notice dd {
  margin: 0;
  font-size: var(--dsh-font-size-micro);
}

.conversation-notice dt {
  color: #9b8a74;
}

.conversation-notice__actions {
  display: flex;
  gap: 7px;
}

.error-notice {
  border-color: #efc8cc;
  background: #fff5f6;
}

.error-notice .conversation-notice__icon {
  color: #a92e3c;
  background: #ffe2e5;
}

.error-notice code {
  display: inline-block;
  margin-top: 7px;
  color: #9b3c47;
  font-size: var(--dsh-font-size-micro);
}

.conversation-end {
  height: 12px;
}

.conversation-composer-dock {
  position: absolute;
  z-index: 11;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 48px 28px 13px;
  background: linear-gradient(to bottom, rgb(255 255 255 / 0%), #fff 31%, #fff 100%);
  pointer-events: none;
}

.conversation-composer-dock__inner {
  width: min(100%, 920px);
  margin: 0 auto;
  pointer-events: auto;
}

.conversation-composer-dock__inner > p {
  margin: 7px 0 0;
  color: #aaada9;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

.conversation-composer-dock :deep(.composer__surface) {
  border-color: #dedfdd;
  border-radius: 15px;
  box-shadow: 0 9px 28px rgb(28 31 28 / 7%);
}

.conversation-composer-dock :deep(.composer__input) {
  min-height: 76px;
  font-size: var(--dsh-font-size-body);
}

.jump-latest {
  display: flex;
  align-items: center;
  width: max-content;
  min-height: 29px;
  gap: 5px;
  margin: 0 auto 9px;
  padding: 0 10px;
  border: 1px solid #dedfdd;
  border-radius: 999px;
  color: #626762;
  background: #fff;
  box-shadow: 0 5px 16px rgb(25 30 26 / 7%);
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
  pointer-events: auto;
}

.drawer-section + .drawer-section {
  margin-top: 28px;
}

.drawer-section h2 {
  margin: 0 0 12px;
  color: #272a27;
  font-size: var(--dsh-font-size-body);
}

.run-facts {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid #e5e7e4;
  border-radius: 10px;
  background: #fafbfa;
}

.run-facts div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid #eceeeb;
}

.run-facts div:last-child {
  border-bottom: 0;
}

.run-facts dt,
.run-facts dd {
  margin: 0;
  font-size: var(--dsh-font-size-badge);
}

.run-facts dt {
  color: #8a8f8a;
}

.run-facts dd {
  color: #424742;
  text-align: right;
}

.source-list {
  display: grid;
  gap: 8px;
}

.source-list article {
  padding: 11px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
}

.source-list article > span {
  color: #4c806f;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.source-list strong {
  display: block;
  margin-top: 4px;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
}

.source-list p {
  margin: 5px 0 0;
  color: #828782;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.drawer-artifacts {
  display: grid;
  gap: 8px;
}

.drawer-artifacts button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
  color: #48695e;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.drawer-artifacts button > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.drawer-artifacts strong {
  overflow: hidden;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-artifacts small {
  margin-top: 3px;
  color: #929692;
  font-size: var(--dsh-font-size-micro);
}

.artifact-preview {
  padding: 18px 10px 8px;
  text-align: center;
}

.artifact-preview__icon {
  display: grid;
  width: 52px;
  height: 52px;
  margin: 0 auto;
  place-items: center;
  border-radius: 14px;
  color: #356858;
  background: #eaf4f0;
  font-size: var(--dsh-font-size-page-title);
}

.artifact-preview h3 {
  margin: 13px 0 0;
  font-size: var(--dsh-font-size-subheading);
}

.artifact-preview > p {
  max-width: 520px;
  margin: 8px auto 0;
  color: #737873;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.artifact-preview dl {
  display: flex;
  justify-content: center;
  gap: 28px;
  margin: 19px 0 0;
}

.artifact-preview dl div {
  display: flex;
  flex-direction: column;
}

.artifact-preview dt {
  color: #979b97;
  font-size: var(--dsh-font-size-micro);
}

.artifact-preview dd {
  margin: 4px 0 0;
  color: #3f443f;
  font-size: var(--dsh-font-size-badge);
}

.artifact-preview__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  gap: 8px;
  margin-top: 20px;
  border: 1px dashed #dfe2de;
  border-radius: 11px;
  color: #8a8f8a;
  background: #fafbfa;
  font-size: var(--dsh-font-size-badge);
}

@media (max-width: 720px) {
  .conversation-header {
    min-height: 58px;
    padding: 0 10px 0 52px;
  }

  .conversation-header__back {
    display: none;
  }

  .conversation-header__actions {
    gap: 0;
  }

  .conversation-header__actions .status-tag,
  .header-action-label {
    display: none;
  }

  .conversation-scroll {
    padding: 78px 14px 218px;
  }

  .conversation-message--user {
    padding-left: 12%;
  }

  .user-message {
    max-width: 88%;
  }

  .assistant-answer,
  .working-answer {
    margin-left: 0;
  }

  .assistant-answer > p {
    font-size: var(--dsh-font-size-caption);
    line-height: 1.8;
  }

  .conversation-notice {
    grid-template-columns: 30px minmax(0, 1fr);
    margin-left: 0;
  }

  .conversation-notice__actions,
  .conversation-notice > .el-button {
    grid-column: 1 / -1;
    justify-self: end;
  }

  .conversation-notice dl {
    flex-direction: column;
    gap: 5px;
  }

  .conversation-composer-dock {
    padding: 40px 10px 9px;
  }

  .conversation-composer-dock :deep(.composer__input) {
    min-height: 70px;
  }

  .assistant-run-meta {
    display: none;
  }

  .answer-artifacts button {
    width: 100%;
  }
}
</style>
