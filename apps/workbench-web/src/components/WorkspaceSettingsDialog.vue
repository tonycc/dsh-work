<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { workbenchApi } from '@/api/client'
import type { TeamMemberRole, WorkspaceMember } from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const props = withDefaults(
  defineProps<{
    open: boolean
    workspaceId: string
    workspaceName?: string
    workspaceDescription?: string
    /** 当前操作人角色；无法判定时传 null，此时只渲染只读信息。 */
    currentUserRole?: TeamMemberRole | null
    /** 员工成员列表：转交目标来自现有成员，需要 `GET /workspaces/:id/members`。 */
    members?: WorkspaceMember[]
    /** 保存名称/说明不可用时（缺少更新接口）在弹窗内说明。 */
    saveWarning?: string
  }>(),
  {
    workspaceName: '',
    workspaceDescription: '',
    currentUserRole: null,
    members: () => [],
    saveWarning: '',
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  /** 名称/说明保存：当前批次没有对应后端接口，由父级决定如何持久化。 */
  save: [payload: { name: string; description: string | null }]
  transferred: []
  exited: []
}>()

const name = ref(props.workspaceName)
const description = ref(props.workspaceDescription)
const transferTarget = ref('')
const saving = ref(false)
const transferring = ref(false)
const exiting = ref(false)
const ownerCount = computed(() => props.members.filter(member => member.role === 'owner').length)

const isOwner = computed(() => props.currentUserRole === 'owner')
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
}, { immediate: true })

function save() {
  if (!isOwner.value || saving.value) return
  const trimmedName = name.value.trim()
  if (trimmedName.length < 2) {
    ElMessage.warning('空间名称至少需要 2 个字符')
    return
  }
  saving.value = true
  try {
    // 方案 3.3：清空可选说明时显式传 null，由服务端归一化为存储空值。
    emit('save', { name: trimmedName, description: description.value.trim() || null })
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
            :disabled="!isOwner"
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
            :disabled="!isOwner"
            maxlength="200"
            placeholder="留空表示清空说明"
          />
        </label>

        <p v-if="saveWarning" class="settings-dialog__warning">{{ saveWarning }}</p>

        <div v-if="isOwner" class="settings-dialog__actions">
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
