<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Cpu, Plus, Search } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type {
  AgentCandidate,
  TeamMemberRole,
  WorkspaceAgentMember,
  WorkspaceMember,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { memberRoleCapabilities } from '@/utils/member-roles'

const props = withDefaults(
  defineProps<{
    open: boolean
    workspaceId: string
    workspaceName?: string
    /**
     * 当前操作人在该团队的员工角色。服务端契约尚未返回该字段（见 T6 报告
     * 缺口），父级无法判定时传 `null`，此时员工段只读、不渲染写入口。
     */
    currentUserRole?: TeamMemberRole | null
    /** 员工成员列表：需要 `GET /workspaces/:id/members`（T6 报告的后端缺口）。 */
    members?: WorkspaceMember[]
    /** Agent 成员列表：优先由本组件按 `loadAgentMembers` 通过既有 T4 接口加载。 */
    agentMembers?: WorkspaceAgentMember[]
    loadAgentMembers?: boolean
    /** 员工成员列表不可用时的说明（例如后端尚未提供列表接口）。 */
    membersWarning?: string
  }>(),
  {
    workspaceName: '',
    currentUserRole: null,
    members: () => [],
    agentMembers: () => [],
    loadAgentMembers: true,
    membersWarning: '',
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  refresh: []
  'role-changed': []
  'start-conversation': [agentMemberId: string]
}>()

const roleLabels: Record<TeamMemberRole, string> = {
  owner: '负责人',
  admin: '管理员',
  member: '成员',
  viewer: '只读成员',
}
const roleValues: TeamMemberRole[] = ['owner', 'admin', 'member', 'viewer']

const loadingAgents = ref(false)
const loadAgentError = ref('')

const candidate = ref<{
  open: boolean
  loading: boolean
  query: string
  items: AgentCandidate[]
  nextCursor: string | null
  selected: AgentCandidate | null
}>({ open: false, loading: false, query: '', items: [], nextCursor: null, selected: null })
const addingAgent = ref(false)

const employeeSearch = ref<{
  open: boolean
  loading: boolean
  query: string
  items: Array<{ id: string; displayName: string; department: string }>
  nextCursor: string | null
}>({ open: false, loading: false, query: '', items: [], nextCursor: null })
const addingEmployee = ref('')

const agentMemberList = ref<WorkspaceAgentMember[]>(props.agentMembers)

const isOwner = computed(() => props.currentUserRole === 'owner')
const canManageEmployees = computed(() => isOwner.value || props.currentUserRole === 'admin')
const ownerCount = computed(() => props.members.filter(member => member.role === 'owner').length)

/**
 * 严格照 plan 第 5 节权限矩阵推导员工段可写动作（实现见 utils/member-roles）：
 * 负责人可改全员；管理员只能改「成员／只读成员」，且不能改自己和其他管理员；
 * 最后负责人锁定。
 */
function editableRoles(member: WorkspaceMember): TeamMemberRole[] {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).editableRoles
}

/**
 * 当前操作人身份暂不可从服务端契约判定（见 T6 报告缺口）：无法确认「自己」
 * 是哪一行，因此管理员行一律按不可管理处理，绝不会误改或误移除自己。
 */
function isSelf(member: WorkspaceMember) {
  void member
  return false
}

/** 权限矩阵：负责人可移除全员；管理员只能移除「成员／只读成员」。 */
function canRemove(member: WorkspaceMember) {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).removable
}

function roleSelectValue(member: WorkspaceMember) {
  return roleValues.includes(member.role) ? member.role : 'member'
}

function isLastOwner(member: WorkspaceMember) {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).lastOwner
}

async function refreshAgentMembers() {
  if (!props.loadAgentMembers || !props.workspaceId) return
  loadingAgents.value = true
  loadAgentError.value = ''
  try {
    agentMemberList.value = await workbenchApi.listWorkspaceAgentMembers(props.workspaceId)
  } catch (error) {
    notifyActionFailure('加载 Agent 成员', `工作空间“${props.workspaceName}”`, error, '重新打开弹窗或稍后刷新页面重试。')
    loadAgentError.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    loadingAgents.value = false
  }
}

watch(() => props.agentMembers, (value) => {
  if (!props.loadAgentMembers) agentMemberList.value = value
})

watch(() => props.open, (open) => {
  if (!open) return
  if (props.loadAgentMembers) void refreshAgentMembers()
}, { immediate: true })

watch(() => props.members, () => {
  if (employeeSearch.value.open) void ensureEmployeeCandidates()
})

/** 已加入者按服务端口径排除，前端再按本地成员列表兜底去重。 */
async function ensureEmployeeCandidates(reset = true) {
  if (!canManageEmployees.value || !props.workspaceId) return
  if (reset) {
    employeeSearch.value.items = []
    employeeSearch.value.nextCursor = null
  }
  employeeSearch.value.loading = true
  try {
    const page = await workbenchApi.listMemberCandidates(props.workspaceId, {
      ...(employeeSearch.value.query ? { query: employeeSearch.value.query } : {}),
      ...(reset ? {} : employeeSearch.value.nextCursor ? { cursor: employeeSearch.value.nextCursor } : {}),
      limit: 10,
    })
    const joined = new Set(props.members.map(member => member.userId))
    const merged = reset ? page.items : [...employeeSearch.value.items, ...page.items]
    employeeSearch.value.items = merged.filter(item => !joined.has(item.id))
    employeeSearch.value.nextCursor = page.nextCursor
  } catch (error) {
    notifyActionFailure('搜索员工', '企业员工目录', error, '稍后重试；仍失败请联系管理员检查员工目录权限。')
  } finally {
    employeeSearch.value.loading = false
  }
}

let employeeSearchTimer: ReturnType<typeof setTimeout> | undefined
function onEmployeeSearchInput(value: string) {
  if (value === employeeSearch.value.query) return
  employeeSearch.value.query = value
  if (employeeSearchTimer) clearTimeout(employeeSearchTimer)
  employeeSearchTimer = setTimeout(() => void ensureEmployeeCandidates(), 300)
}

function openEmployeeSearch() {
  employeeSearch.value.open = true
  void ensureEmployeeCandidates()
}

async function addEmployee(candidateUserId: string) {
  if (addingEmployee.value) return
  addingEmployee.value = candidateUserId
  try {
    await workbenchApi.addWorkspaceMember(props.workspaceId, { userId: candidateUserId, role: 'member' })
    ElMessage.success('已添加员工成员')
    employeeSearch.value.open = false
    employeeSearch.value.query = ''
    emit('refresh')
  } catch (error) {
    notifyActionFailure('添加员工', `工作空间“${props.workspaceName}”`, error, '确认该员工在职、有应用访问资格且尚未加入本空间。')
  } finally {
    addingEmployee.value = ''
  }
}

async function changeMemberRole(member: WorkspaceMember, role: TeamMemberRole) {
  if (!editableRoles(member).includes(role) || role === member.role) return
  try {
    await workbenchApi.updateMemberRole(props.workspaceId, member.userId, { role })
    ElMessage.success(`已将“${member.displayName}”调整为${roleLabels[role]}`)
    emit('role-changed')
  } catch (error) {
    notifyActionFailure('调整角色', `成员“${member.displayName}”`, error, '确认你仍拥有该角色的任免权限后重试。')
  }
}

async function removeMember(member: WorkspaceMember) {
  if (!canRemove(member) || isLastOwner(member)) return
  try {
    await ElMessageBox.confirm(
      `移除后“${member.displayName}”立即失去该空间的后续访问；其已共享的贡献与作者归属保留，下载链接会重新鉴权。`,
      `移除成员“${member.displayName}”？`,
      { confirmButtonText: '移除成员', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  try {
    await workbenchApi.removeWorkspaceMember(props.workspaceId, member.userId)
    ElMessage.success(`已移除“${member.displayName}”`)
    emit('refresh')
  } catch (error) {
    notifyActionFailure('移除成员', `成员“${member.displayName}”`, error, '确认你不是在移除最后一位负责人后重试。')
  }
}

function openAgentSearch() {
  candidate.value.open = true
  candidate.value.selected = null
  void searchAgentCandidates('')
}

let agentSearchTimer: ReturnType<typeof setTimeout> | undefined
function onAgentSearchInput(value: string) {
  if (value === candidate.value.query) return
  candidate.value.query = value
  if (agentSearchTimer) clearTimeout(agentSearchTimer)
  agentSearchTimer = setTimeout(() => void searchAgentCandidates(value), 300)
}

async function searchAgentCandidates(query: string) {
  if (!isOwner.value) return
  candidate.value.loading = true
  try {
    const page = await workbenchApi.listWorkspaceAgentCandidates(props.workspaceId, {
      ...(query ? { query } : {}),
      limit: 10,
    })
    candidate.value.items = page.items
    candidate.value.nextCursor = page.nextCursor
  } catch (error) {
    notifyActionFailure('搜索 Agent', '平台已发布 Agent', error, '确认当前为负责人且平台允许该 Agent 加入本空间。')
  } finally {
    candidate.value.loading = false
  }
}

function selectAgentCandidate(item: AgentCandidate) {
  candidate.value.selected = item
}

async function confirmAddAgent() {
  const selected = candidate.value.selected
  if (!selected || addingAgent.value) return
  addingAgent.value = true
  try {
    await workbenchApi.addWorkspaceAgentMember(props.workspaceId, { agentId: selected.agentId })
    ElMessage.success(`已加入 Agent“${selected.name}”`)
    candidate.value.open = false
    candidate.value.selected = null
    emit('refresh')
    if (props.loadAgentMembers) await refreshAgentMembers()
  } catch (error) {
    notifyActionFailure('添加 Agent 成员', `Agent“${selected.name}”`, error, '确认该 Agent 已发布、允许加入且 Skill／Tool 依赖完整。')
  } finally {
    addingAgent.value = false
  }
}

const agentActionCopy: Record<'disable' | 'enable' | 'upgrade' | 'remove', { label: string; confirm: string }> = {
  disable: { label: '停用', confirm: '停用后阻止该 Agent 的后续启动、续写与重试；排队与在途运行按既有取消链路收敛，历史消息与成果保留。' },
  enable: { label: '重新启用', confirm: '重新启用后成员可以再次使用该 Agent 发起新对话；既有会话仍固定原版本。' },
  upgrade: { label: '升级', confirm: '升级只影响新会话的默认版本；既有 Session、Run 与 Attempt 保持原快照。' },
  remove: { label: '移出', confirm: '移出后阻止后续启动、续写与重试；排队与在途运行按既有取消链路收敛，历史消息与成果保留。' },
}

async function runAgentAction(member: WorkspaceAgentMember, action: 'disable' | 'enable' | 'upgrade' | 'remove') {
  if (!member.allowedActions.includes(action)) return
  try {
    await ElMessageBox.confirm(
      agentActionCopy[action].confirm,
      `${agentActionCopy[action].label} Agent“${member.name}”？`,
      { confirmButtonText: agentActionCopy[action].label, cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    if (action === 'remove') await workbenchApi.removeWorkspaceAgentMember(props.workspaceId, member.id)
    else await workbenchApi.updateWorkspaceAgentMember(props.workspaceId, member.id, { action })
    ElMessage.success(`已${agentActionCopy[action].label}“${member.name}”`)
    emit('refresh')
    if (props.loadAgentMembers) await refreshAgentMembers()
  } catch (error) {
    notifyActionFailure(`${agentActionCopy[action].label} Agent`, `Agent“${member.name}”`, error, '刷新成员列表确认当前状态后重试。')
  }
}

function startConversation(member: WorkspaceAgentMember) {
  if (!member.allowedActions.includes('start_conversation')) return
  emit('start-conversation', member.id)
}

function agentStatusLabel(member: WorkspaceAgentMember) {
  return member.status === 'available' ? '可用' : '已停用'
}

function agentStatusTone(member: WorkspaceAgentMember) {
  return member.status === 'available' ? 'success' : 'neutral'
}

function close() {
  emit('update:open', false)
}

onBeforeUnmount(() => {
  if (employeeSearchTimer) clearTimeout(employeeSearchTimer)
  if (agentSearchTimer) clearTimeout(agentSearchTimer)
})

defineExpose({ ensureEmployeeCandidates })
</script>

<template>
  <el-dialog
    :model-value="open"
    class="member-dialog"
    title="管理成员"
    width="min(600px, calc(100vw - 32px))"
    :append-to-body="false"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="member-dialog__body">
      <p class="member-dialog__hint">
        员工与 Agent 分别管理：员工按负责人／管理员／成员／只读成员授权，Agent 只按关联版本与可用状态呈现。
      </p>

      <section data-testid="member-section-employee" class="member-dialog__section">
        <header class="member-dialog__section-heading">
          <h3>员工</h3>
          <span>{{ members.length }} 位员工</span>
        </header>

        <p v-if="membersWarning" class="member-dialog__warning">{{ membersWarning }}</p>

        <div v-if="members.length" class="member-dialog__list">
          <article
            v-for="member in members"
            :key="member.userId"
            data-testid="member-row"
            class="member-dialog__row"
          >
            <span class="member-dialog__avatar">{{ Array.from(member.displayName)[0] ?? '成' }}</span>
            <div class="member-dialog__copy">
              <strong>{{ member.displayName }}</strong>
              <span v-if="isSelf(member)">本人</span>
            </div>

            <template v-if="canManageEmployees">
              <span v-if="isLastOwner(member)" data-testid="member-role-unique" class="member-dialog__role-unique">
                负责人（唯一）
              </span>
              <el-select
                v-else
                data-testid="member-role-select"
                class="member-dialog__role"
                :model-value="roleSelectValue(member)"
                :disabled="editableRoles(member).length === 0"
                :aria-label="`调整“${member.displayName}”的角色`"
                @change="changeMemberRole(member, $event)"
              >
                <el-option
                  v-for="role in roleValues"
                  :key="role"
                  :label="roleLabels[role]"
                  :value="role"
                  :disabled="!editableRoles(member).includes(role)"
                />
              </el-select>
              <el-button
                v-if="canRemove(member) && !isLastOwner(member)"
                data-testid="member-remove"
                plain
                @click="removeMember(member)"
              >
                移除
              </el-button>
            </template>

            <span
              v-else
              data-testid="member-role-readonly"
              class="member-dialog__role-readonly"
            >
              {{ roleLabels[member.role] }}
            </span>
          </article>
        </div>

        <p v-else data-testid="member-empty" class="member-dialog__empty">尚未添加员工</p>

        <div v-if="canManageEmployees" class="member-dialog__add">
          <el-button data-testid="member-add-employee" :icon="Plus" @click="openEmployeeSearch">添加员工</el-button>
        </div>

        <div v-if="employeeSearch.open" class="member-dialog__picker">
          <el-input
            data-testid="member-candidate-search"
            :model-value="employeeSearch.query"
            :prefix-icon="Search"
            placeholder="输入姓名搜索企业员工"
            clearable
            @update:model-value="onEmployeeSearchInput"
          />
          <p class="member-dialog__picker-note">仅显示在职、有应用访问资格且尚未加入本空间的员工。</p>
          <div v-if="employeeSearch.items.length" class="member-dialog__picker-list">
            <article
              v-for="item in employeeSearch.items"
              :key="item.id"
              data-testid="member-candidate-row"
              class="member-dialog__picker-row"
            >
              <div class="member-dialog__copy">
                <strong>{{ item.displayName }}</strong>
                <span>{{ item.department }}</span>
              </div>
              <el-button :disabled="addingEmployee === item.id" @click="addEmployee(item.id)">加入</el-button>
            </article>
          </div>
          <p v-else-if="!employeeSearch.loading" class="member-dialog__empty">没有可添加的员工</p>
          <el-button
            v-if="employeeSearch.nextCursor"
            data-testid="member-candidate-more"
            text
            @click="ensureEmployeeCandidates(false)"
          >
            加载更多
          </el-button>
        </div>
      </section>

      <section data-testid="member-section-agent" class="member-dialog__section">
        <header class="member-dialog__section-heading">
          <h3>Agent</h3>
          <span>{{ agentMemberList.length }} 个 Agent</span>
        </header>

        <div v-if="agentMemberList.length" class="member-dialog__list">
          <article
            v-for="member in agentMemberList"
            :key="member.id"
            data-testid="agent-member-row"
            class="member-dialog__row"
          >
            <span class="member-dialog__agent-icon"><el-icon><Cpu /></el-icon></span>
            <div class="member-dialog__copy">
              <strong>{{ member.name }}</strong>
              <span>{{ member.description }}</span>
            </div>
            <el-tooltip
              :content="member.unavailableReason || agentStatusLabel(member)"
              placement="top"
            >
              <span
                data-testid="agent-status-tooltip"
                class="member-dialog__status"
                :class="`member-dialog__status--${agentStatusTone(member)}`"
                :aria-label="`Agent 状态：${agentStatusLabel(member)}`"
              />
            </el-tooltip>
            <div class="member-dialog__actions">
              <el-button
                v-if="member.allowedActions.includes('start_conversation')"
                data-testid="agent-start-conversation"
                plain
                @click="startConversation(member)"
              >
                开始对话
              </el-button>
              <el-button
                v-if="member.allowedActions.includes('disable')"
                data-testid="agent-action-disable"
                plain
                @click="runAgentAction(member, 'disable')"
              >
                停用
              </el-button>
              <el-button
                v-if="member.allowedActions.includes('enable')"
                data-testid="agent-action-enable"
                plain
                @click="runAgentAction(member, 'enable')"
              >
                重新启用
              </el-button>
              <el-button
                v-if="member.allowedActions.includes('upgrade')"
                data-testid="agent-action-upgrade"
                plain
                @click="runAgentAction(member, 'upgrade')"
              >
                升级
              </el-button>
              <el-button
                v-if="member.allowedActions.includes('remove')"
                data-testid="agent-action-remove"
                plain
                @click="runAgentAction(member, 'remove')"
              >
                移出
              </el-button>
            </div>
          </article>
        </div>

        <p v-else data-testid="agent-empty" class="member-dialog__empty">
          <span>尚未加入 Agent</span>
          <small v-if="isOwner">从平台已发布且允许加入本空间的 Agent 中选择，确认职责与依赖后加入。</small>
          <small v-else>请联系负责人添加可用的 Agent。</small>
        </p>

        <p v-if="loadAgentError" class="member-dialog__warning">{{ loadAgentError }}</p>

        <div v-if="isOwner" class="member-dialog__add">
          <el-button data-testid="member-add-agent" :icon="Plus" :loading="loadingAgents" @click="openAgentSearch">
            添加 Agent
          </el-button>
        </div>

        <div v-if="candidate.open" class="member-dialog__picker">
          <el-input
            data-testid="member-agent-search"
            :model-value="candidate.query"
            :prefix-icon="Search"
            placeholder="输入名称搜索平台已发布 Agent"
            clearable
            @update:model-value="onAgentSearchInput"
          />
          <div v-if="candidate.items.length" class="member-dialog__picker-list">
            <article
              v-for="item in candidate.items"
              :key="item.agentId"
              data-testid="agent-candidate-row"
              class="member-dialog__picker-row"
            >
              <div class="member-dialog__copy">
                <strong>{{ item.name }}</strong>
                <span>{{ item.description }} · 固定版本 {{ item.activeVersion }}</span>
              </div>
              <el-button @click="selectAgentCandidate(item)">查看详情</el-button>
            </article>
          </div>
          <p v-else-if="!candidate.loading" class="member-dialog__empty">没有可加入的 Agent</p>

          <div v-if="candidate.selected" data-testid="agent-candidate-detail" class="member-dialog__detail">
            <h4>{{ candidate.selected.name }}</h4>
            <dl>
              <div>
                <dt>职责</dt>
                <dd>{{ candidate.selected.description || '—' }}</dd>
              </div>
              <div>
                <dt>关联技能</dt>
                <dd>{{ candidate.selected.skillNames?.join('、') || '详情待平台补充' }}</dd>
              </div>
              <div>
                <dt>所需工具</dt>
                <dd>{{ candidate.selected.toolNames?.join('、') || '详情待平台补充' }}</dd>
              </div>
              <div>
                <dt>数据范围</dt>
                <dd>{{ candidate.selected.dataScope || '详情待平台补充' }}</dd>
              </div>
            </dl>
            <el-button
              type="primary"
              data-testid="agent-candidate-confirm"
              :loading="addingAgent"
              @click="confirmAddAgent"
            >
              确认加入
            </el-button>
          </div>
        </div>
      </section>

      <footer class="member-dialog__footer">
        <el-button data-testid="member-dialog-close" @click="close">关闭</el-button>
      </footer>
    </div>
  </el-dialog>
</template>

<style scoped>
.member-dialog__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.member-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 62vh;
  overflow-y: auto;
}

.member-dialog__hint {
  margin: 0;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.member-dialog__section {
  padding: 13px;
  border: 1px solid #e6e8e5;
  border-radius: 11px;
  background: #fff;
}

.member-dialog__section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.member-dialog__section-heading h3 {
  margin: 0;
  color: #303430;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.member-dialog__section-heading span {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__list {
  margin-top: 9px;
}

.member-dialog__row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 7px 0;
  border-bottom: 1px solid #eef0ed;
}

.member-dialog__row:last-child {
  border-bottom: 0;
}

.member-dialog__avatar,
.member-dialog__agent-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  color: #31443e;
  background: #d9ece3;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.member-dialog__agent-icon {
  border-radius: 9px;
  color: #176750;
  background: #e8f5f0;
}

.member-dialog__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.member-dialog__copy strong {
  overflow: hidden;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-dialog__copy span {
  margin-top: 3px;
  overflow: hidden;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-dialog__role {
  width: 118px;
}

.member-dialog__role-unique,
.member-dialog__role-readonly {
  color: #6f756f;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__status {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c3c8c4;
}

.member-dialog__status--success {
  background: #2e8b70;
}

.member-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.member-dialog__empty,
.member-dialog__warning,
.member-dialog__picker-note {
  margin: 9px 0 0;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.member-dialog__empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.member-dialog__warning {
  color: #a4642a;
}

.member-dialog__add {
  margin-top: 10px;
}

.member-dialog__picker {
  margin-top: 10px;
  padding: 10px;
  border: 1px dashed #d7ded9;
  border-radius: 10px;
  background: #fafbf9;
}

.member-dialog__picker-list {
  margin-top: 8px;
}

.member-dialog__picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #eef0ed;
}

.member-dialog__picker-row:last-child {
  border-bottom: 0;
}

.member-dialog__detail {
  margin-top: 10px;
  padding: 11px;
  border: 1px solid #dfe7e2;
  border-radius: 10px;
  background: #fff;
}

.member-dialog__detail h4 {
  margin: 0 0 8px;
  color: #24443a;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.member-dialog__detail dl {
  margin: 0 0 10px;
}

.member-dialog__detail dl > div {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
}

.member-dialog__detail dt {
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__detail dd {
  margin: 0;
  color: #454a46;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
}

@media (max-width: 640px) {
  .member-dialog__row {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .member-dialog__role,
  .member-dialog__role-unique,
  .member-dialog__role-readonly,
  .member-dialog__actions {
    grid-column: 2 / -1;
  }
}
</style>
