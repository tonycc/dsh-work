<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { TeamMemberRole, Workspace, WorkspaceMember, WorkspaceStatus } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const props = withDefaults(
  defineProps<{
    open: boolean
    workspaceId: string
    workspaceName?: string
    workspaceDescription?: string
    /** 服务端返回的空间状态：归档时只读基本信息并渲染恢复入口（design §2.7）。 */
    workspaceStatus?: WorkspaceStatus
    /** 当前操作人角色；无法判定时传 null，此时只渲染只读信息。 */
    currentUserRole?: TeamMemberRole | null
    /** 员工成员列表：转交目标来自现有成员，需要 `GET /workspaces/:id/members`。 */
    members?: WorkspaceMember[]
  }>(),
  {
    workspaceName: '',
    workspaceDescription: '',
    workspaceStatus: 'active',
    currentUserRole: null,
    members: () => [],
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** 名称/说明保存成功：携带服务端返回的更新后空间摘要。 */
  saved: [workspace: Workspace]
  /** 归档或恢复成功：父级据此刷新空间状态。 */
  'archive-changed': []
  transferred: []
  exited: []
}>()

const name = ref(props.workspaceName)
const description = ref(props.workspaceDescription)
const transferTarget = ref('')
const saving = ref(false)
const transferring = ref(false)
const exiting = ref(false)
const archiving = ref(false)
const restoring = ref(false)
/** 归档被运行中任务拒绝时的行内提示（409 state_conflict），保留服务器给出的数量与步骤。 */
const archiveConflict = ref('')
const ownerCount = computed(() => props.members.filter(member => member.role === 'owner').length)

const isOwner = computed(() => props.currentUserRole === 'owner')
const isArchived = computed(() => props.workspaceStatus === 'archived')
const isOnlyOwner = computed(() => isOwner.value && ownerCount.value <= 1)
/** 转交目标：其他成员（唯一负责人优先转交，负责人也可再转交）。 */
const transferCandidates = computed(() => props.members.filter(member => member.role !== 'owner'))

watch(() => props.open, (open) => {
  if (!open) return
  name.value = props.workspaceName
  description.value = props.workspaceDescription
  transferTarget.value = ''
  saving.value = false
  transferring.value = false
  exiting.value = false
  archiving.value = false
  restoring.value = false
  archiveConflict.value = ''
}, { immediate: true })

/**
 * 名称/说明保存（3-T3：`PATCH /workspaces/:id` 已就绪）。清空可选说明时显式传
 * `null`，由服务端归一化为存储空值（方案 3.3）。
 */
async function save() {
  if (!isOwner.value || saving.value || isArchived.value) return
  const trimmedName = name.value.trim()
  if (trimmedName.length < 2) {
    ElMessage.warning('空间名称至少需要 2 个字符')
    return
  }
  saving.value = true
  try {
    const updated = await workbenchApi.updateWorkspace(props.workspaceId, {
      name: trimmedName,
      description: description.value.trim() || null,
    })
    ElMessage.success('空间名称与说明已保存')
    emit('saved', updated)
  } catch (error) {
    notifyActionFailure(
      '保存空间设置',
      `工作空间“${props.workspaceName}”`,
      error,
      '确认名称在 2–60 个字符之间后重试；说明留空表示清空。',
    )
  } finally {
    saving.value = false
  }
}

async function transferOwner() {
  if (!isOwner.value || transferring.value || !transferTarget.value) return
  const target = props.members.find(member => member.userId === transferTarget.value)
  try {
    await ElMessageBox.confirm(
      `转交后你成为普通成员，不再拥有空间设置、成员管理与 Agent 成员管理权限；内容最初创建者不会被改写。“${target?.displayName ?? ''}”将成为新的负责人。`,
      '转交负责人？',
      { confirmButtonText: '转交负责人', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  transferring.value = true
  try {
    await workbenchApi.transferWorkspaceOwner(props.workspaceId, { toUserId: transferTarget.value })
    ElMessage.success('已转交负责人')
    emit('transferred')
  } catch (error) {
    notifyActionFailure('转交负责人', `工作空间“${props.workspaceName}”`, error, '刷新成员列表确认对方仍是成员后重试。')
  } finally {
    transferring.value = false
  }
}

async function exitWorkspace() {
  if (exiting.value) return
  if (isOnlyOwner.value) {
    ElMessage.warning('你是唯一负责人，请先转交负责人再退出空间')
    return
  }
  try {
    await ElMessageBox.confirm(
      '退出后你立即失去该空间的访问权限；你已共享的文件、分享快照与成果保持原发布状态和作者归属，不会被删除或转移。',
      `退出空间“${props.workspaceName}”？`,
      { confirmButtonText: '退出空间', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  exiting.value = true
  try {
    await workbenchApi.exitWorkspace(props.workspaceId)
    ElMessage.success('已退出该空间')
    emit('exited')
  } catch (error) {
    notifyActionFailure('退出空间', `工作空间“${props.workspaceName}”`, error, '确认你不是最后一位负责人后重试。')
  } finally {
    exiting.value = false
  }
}

/**
 * 归档空间（design §2.7 / TW-06）：仅负责人；二次确认，不自动中断在途任务。
 * 服务端在有排队/运行中 Run 时返回 409 `state_conflict`，此处把服务器的数量与
 * 「等待或先取消」指引行内展示，而不是弹一个泛化失败。
 */
async function archiveWorkspace() {
  if (!isOwner.value || archiving.value || isArchived.value) return
  try {
    await ElMessageBox.confirm(
      `归档后现任成员仍可按权限查看与下载，但新增对话、续写、重试、上传、成员与设置变更都会被拒绝；可随时恢复。“${props.workspaceName}”归档后变为只读。`,
      `归档空间“${props.workspaceName}”？`,
      { confirmButtonText: '归档空间', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  archiving.value = true
  archiveConflict.value = ''
  try {
    await workbenchApi.archiveWorkspace(props.workspaceId)
    ElMessage.success('空间已归档')
    emit('archive-changed')
  } catch (error) {
    if (error instanceof WorkbenchApiError && error.status === 409) {
      // 保留服务端给出的任务数量与处置建议（等待任务完成或先取消）。
      archiveConflict.value = error.message
    } else {
      notifyActionFailure('归档空间', `工作空间“${props.workspaceName}”`, error, '稍后重试；若有任务在途，请先等待或取消。')
    }
  } finally {
    archiving.value = false
  }
}

/** 恢复空间（design §2.7，负责人-only）。恢复不重新添加已移除成员、不扩大授权。 */
async function restoreWorkspace() {
  if (!isOwner.value || restoring.value || !isArchived.value) return
  try {
    await ElMessageBox.confirm(
      `恢复后写入口按当前权限重新出现；不会重新添加已移除成员，也不扩大授权。“${props.workspaceName}”将恢复为活动空间。`,
      '恢复空间？',
      { confirmButtonText: '恢复空间', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  restoring.value = true
  try {
    await workbenchApi.restoreWorkspace(props.workspaceId)
    ElMessage.success('已恢复该空间')
    emit('archive-changed')
  } catch (error) {
    notifyActionFailure('恢复空间', `工作空间“${props.workspaceName}”`, error, '稍后重试；若仍失败，请联系管理员。')
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <el-dialog
    :model-value="open"
    class="settings-dialog"
    title="空间设置"
    width="min(520px, calc(100vw - 32px))"
    :append-to-body="false"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="settings-dialog__body">
      <section class="settings-dialog__section">
        <header class="settings-dialog__section-heading">
          <h3>基本信息</h3>
          <span>{{ isOwner ? '负责人可修改' : '仅负责人可修改' }}</span>
        </header>

        <label class="settings-dialog__field">
          <span>空间名称</span>
          <el-input
            data-testid="settings-name"
            v-model="name"
            :disabled="!isOwner || isArchived"
            maxlength="40"
            show-word-limit
          />
        </label>

        <label class="settings-dialog__field">
          <span>空间说明</span>
          <el-input
            data-testid="settings-description"
            v-model="description"
            type="textarea"
            :rows="3"
            :disabled="!isOwner || isArchived"
            maxlength="200"
            placeholder="留空表示清空说明"
          />
        </label>

        <p v-if="isOwner && isArchived" class="settings-dialog__note">
          空间已归档，名称与说明暂不可修改；先恢复空间再编辑。
        </p>

        <div v-if="isOwner && !isArchived" class="settings-dialog__actions">
          <el-button type="primary" data-testid="settings-save" :loading="saving" @click="save">保存修改</el-button>
        </div>
      </section>

      <section v-if="isOwner" data-testid="settings-transfer" class="settings-dialog__section">
        <header class="settings-dialog__section-heading">
          <h3>转交负责人</h3>
          <span>转交后你成为普通成员</span>
        </header>

        <div class="settings-dialog__inline">
          <el-select
            data-testid="settings-transfer-target"
            v-model="transferTarget"
            placeholder="选择现有成员"
            class="settings-dialog__select"
          >
            <el-option
              v-for="member in transferCandidates"
              :key="member.userId"
              :label="member.displayName"
              :value="member.userId"
            />
          </el-select>
          <el-button
            data-testid="settings-transfer-confirm"
            :disabled="!transferTarget"
            :loading="transferring"
            @click="transferOwner"
          >
            转交负责人
          </el-button>
        </div>
        <p v-if="!transferCandidates.length" class="settings-dialog__note">空间内还没有其他员工成员可转交。</p>
      </section>

      <section class="settings-dialog__section">
        <header class="settings-dialog__section-heading">
          <h3>退出空间</h3>
          <span>{{ isOnlyOwner ? '需先转交负责人' : '贡献与作者归属保留' }}</span>
        </header>
        <p class="settings-dialog__note">
          退出后你立即失去空间访问；已共享的文件、分享快照与成果保持原发布状态与作者归属（TW-01）。
        </p>
        <div class="settings-dialog__actions">
          <el-button
            data-testid="settings-exit"
            plain
            :loading="exiting"
            @click="exitWorkspace"
          >
            退出空间
          </el-button>
        </div>
      </section>

      <section v-if="isOwner && !isArchived" data-testid="settings-archive" class="settings-dialog__section">
        <header class="settings-dialog__section-heading">
          <h3>归档空间</h3>
          <span>归档后变为只读</span>
        </header>
        <p class="settings-dialog__note">
          归档后现任成员仍可按权限查看与下载会话、文件与成果；新增对话、续写、重试、上传、成员与设置变更会被拒绝，可随时恢复。
        </p>
        <p
          v-if="archiveConflict"
          data-testid="settings-archive-conflict"
          class="settings-dialog__warning"
        >
          {{ archiveConflict }}
        </p>
        <div class="settings-dialog__actions">
          <el-button
            data-testid="settings-archive-confirm"
            :loading="archiving"
            @click="archiveWorkspace"
          >
            归档空间
          </el-button>
        </div>
      </section>

      <section v-if="isOwner && isArchived" data-testid="settings-restore" class="settings-dialog__section">
        <header class="settings-dialog__section-heading">
          <h3>恢复空间</h3>
          <span>恢复后按当前权限开放写入口</span>
        </header>
        <p class="settings-dialog__note">
          恢复只把空间置回活动状态；不会重新添加已移除成员，也不扩大授权。
        </p>
        <div class="settings-dialog__actions">
          <el-button
            data-testid="settings-restore-confirm"
            type="primary"
            :loading="restoring"
            @click="restoreWorkspace"
          >
            恢复空间
          </el-button>
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.settings-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 62vh;
  overflow-y: auto;
}

.settings-dialog__section {
  padding: 12px 13px;
  border: 1px solid #e6e8e5;
  border-radius: 11px;
  background: #fff;
}

.settings-dialog__section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.settings-dialog__section-heading h3 {
  margin: 0;
  color: #303430;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.settings-dialog__section-heading span {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.settings-dialog__field {
  display: block;
  margin-top: 10px;
}

.settings-dialog__field > span {
  display: block;
  margin-bottom: 5px;
  color: #6f756f;
  font-size: var(--dsh-font-size-micro);
}

.settings-dialog__inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.settings-dialog__select {
  flex: 1;
  min-width: 0;
}

.settings-dialog__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}

.settings-dialog__note,
.settings-dialog__warning {
  margin: 8px 0 0;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.settings-dialog__warning {
  color: #a4642a;
}

@media (max-width: 640px) {
  .settings-dialog__inline {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
