<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ArrowDown, ArrowUp, Plus, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { OrganizationEmployee, OrganizationSnapshot } from '@/types/domain'

interface TreeNode {
  id: string
  label: string
  count: number
  children: TreeNode[]
}

const authStore = useAuthStore()
const snapshot = ref<OrganizationSnapshot>({ available: true, departments: [], members: [], employees: [] })
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const selectedId = ref('')
const includeSub = ref(false)
const memberQuery = ref('')

const nameDialog = reactive({ open: false, mode: 'create' as 'create' | 'rename', name: '', error: '' })
const moveDialog = reactive({ open: false, targetId: '' })
const addDialog = reactive({ open: false, query: '', onlyUnassigned: false, picked: [] as string[] })
const removeDialog = reactive({ open: false, user: undefined as OrganizationEmployee | undefined, newPrimaryId: '' })

const canManage = computed(() => authStore.canManage)
const departments = computed(() => snapshot.value.departments)
const departmentById = computed(() => new Map(departments.value.map(department => [department.id, department])))
const rootId = computed(() => departments.value.find(department => department.parentId === null)?.id ?? '')
const selected = computed(() => departmentById.value.get(selectedId.value) ?? departmentById.value.get(rootId.value))
const isRoot = computed(() => selected.value?.parentId === null)
const employeeById = computed(() => new Map(snapshot.value.employees.map(employee => [employee.id, employee])))

const childrenOf = computed(() => {
  const map = new Map<string, typeof departments.value>()
  for (const department of departments.value) {
    if (!department.parentId) continue
    map.set(department.parentId, [...(map.get(department.parentId) ?? []), department])
  }
  for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
  return map
})

function descendants(id: string): string[] {
  return [id, ...(childrenOf.value.get(id) ?? []).flatMap(child => descendants(child.id))]
}

function path(id: string) {
  const names: string[] = []
  let current = departmentById.value.get(id)
  while (current) {
    names.unshift(current.name)
    current = current.parentId ? departmentById.value.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

const membershipsByUser = computed(() => {
  const map = new Map<string, typeof snapshot.value.members>()
  for (const member of snapshot.value.members) map.set(member.userId, [...(map.get(member.userId) ?? []), member])
  return map
})

function usersIn(ids: string[]) {
  const set = new Set(ids)
  return new Set(snapshot.value.members.filter(member => set.has(member.departmentId)).map(member => member.userId))
}

const tree = computed<TreeNode[]>(() => {
  const build = (id: string): TreeNode => ({
    id,
    label: departmentById.value.get(id)?.name ?? '',
    count: usersIn(descendants(id)).size,
    children: (childrenOf.value.get(id) ?? []).map(child => build(child.id)),
  })
  return rootId.value ? [build(rootId.value)] : []
})

const directMemberIds = computed(() => selected.value ? usersIn([selected.value.id]) : new Set<string>())
const subtreeMemberIds = computed(() => selected.value ? usersIn(descendants(selected.value.id)) : new Set<string>())
const selectedChildren = computed(() => selected.value ? childrenOf.value.get(selected.value.id) ?? [] : [])
const siblings = computed(() => selected.value?.parentId ? childrenOf.value.get(selected.value.parentId) ?? [] : [])
const siblingIndex = computed(() => siblings.value.findIndex(sibling => sibling.id === selected.value?.id))

const memberRows = computed(() => {
  const ids = includeSub.value ? subtreeMemberIds.value : directMemberIds.value
  const query = memberQuery.value.trim().toLowerCase()
  return [...ids]
    .map(id => employeeById.value.get(id))
    .filter((employee): employee is OrganizationEmployee => Boolean(employee))
    .filter(employee => !query || employee.name.toLowerCase().includes(query) || (employee.loginAccount ?? '').toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map(employee => {
      const memberships = membershipsByUser.value.get(employee.id) ?? []
      const here = memberships.find(member => member.departmentId === selected.value?.id)
      return {
        employee,
        direct: Boolean(here),
        primaryHere: Boolean(here?.primary),
        departments: memberships
          .map(member => ({ id: member.departmentId, name: departmentById.value.get(member.departmentId)?.name ?? '', primary: member.primary }))
          .sort((a, b) => Number(b.primary) - Number(a.primary)),
      }
    })
})

const assignedCount = computed(() => snapshot.value.employees.filter(employee => membershipsByUser.value.has(employee.id)).length)
const unassignedCount = computed(() => snapshot.value.employees.length - assignedCount.value)
const maxDepth = computed(() => {
  const depth = (id: string): number => 1 + Math.max(0, ...(childrenOf.value.get(id) ?? []).map(child => depth(child.id)))
  return rootId.value ? depth(rootId.value) : 0
})

const candidates = computed(() => {
  const query = addDialog.query.trim().toLowerCase()
  return snapshot.value.employees
    .filter(employee => employee.status === 'active' && !directMemberIds.value.has(employee.id))
    .filter(employee => !addDialog.onlyUnassigned || !membershipsByUser.value.has(employee.id))
    .filter(employee => !query || employee.name.toLowerCase().includes(query) || (employee.loginAccount ?? '').toLowerCase().includes(query))
    .map(employee => {
      const primary = membershipsByUser.value.get(employee.id)?.find(member => member.primary)
      return { employee, department: primary ? departmentById.value.get(primary.departmentId)?.name ?? '' : '' }
    })
})
const allCandidatesPicked = computed(() => candidates.value.length > 0 && candidates.value.every(item => addDialog.picked.includes(item.employee.id)))

const moveTargets = computed(() => {
  if (!selected.value) return []
  const excluded = new Set(descendants(selected.value.id))
  return departments.value
    .filter(department => !excluded.has(department.id) && department.id !== selected.value?.parentId)
    .map(department => ({ id: department.id, label: path(department.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
})

const removeOtherDepartments = computed(() => {
  const user = removeDialog.user
  if (!user) return []
  return (membershipsByUser.value.get(user.id) ?? [])
    .filter(member => member.departmentId !== selected.value?.id)
    .map(member => ({ id: member.departmentId, label: path(member.departmentId) }))
})
const removeNeedsPrimary = computed(() => {
  const user = removeDialog.user
  if (!user) return false
  const here = membershipsByUser.value.get(user.id)?.find(member => member.departmentId === selected.value?.id)
  return Boolean(here?.primary) && removeOtherDepartments.value.length > 0
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    snapshot.value = await adminApi.getOrganization()
    if (!departmentById.value.has(selectedId.value)) selectedId.value = rootId.value
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '组织架构加载失败'
  } finally {
    loading.value = false
  }
}

/** 执行一次写操作并用返回的组织架构替换页面数据；onError 用于把错误显示在表单内而不是全局提示。 */
async function run(action: () => Promise<OrganizationSnapshot>, success: string, onError?: (message: string) => void) {
  saving.value = true
  try {
    snapshot.value = await action()
    if (!departmentById.value.has(selectedId.value)) selectedId.value = rootId.value
    ElMessage.success(success)
    return true
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '操作失败，请重试'
    if (onError) onError(message)
    else ElMessage.error(message)
    return false
  } finally {
    saving.value = false
  }
}

function selectDepartment(node: TreeNode) {
  selectedId.value = node.id
  includeSub.value = false
  memberQuery.value = ''
}

function openName(mode: 'create' | 'rename') {
  Object.assign(nameDialog, { open: true, mode, name: mode === 'rename' ? selected.value?.name ?? '' : '', error: '' })
}

async function saveName() {
  const name = nameDialog.name.trim()
  if (!name) {
    nameDialog.error = '请输入部门名称'
    return
  }
  const department = selected.value
  if (!department) return
  const showInline = (message: string) => { nameDialog.error = message }
  const done = nameDialog.mode === 'create'
    ? await run(() => adminApi.createDepartment(department.id, name), `已新建部门“${name}”`, showInline)
    : await run(() => adminApi.updateDepartment(department.id, { name }), `已改名为“${name}”`, showInline)
  if (done) nameDialog.open = false
}

function openMove() {
  Object.assign(moveDialog, { open: true, targetId: moveTargets.value[0]?.id ?? '' })
}

async function saveMove() {
  const department = selected.value
  if (!department || !moveDialog.targetId) return
  const target = departmentById.value.get(moveDialog.targetId)?.name ?? ''
  if (await run(() => adminApi.updateDepartment(department.id, { parentId: moveDialog.targetId }), `已移动到“${target}”之下`)) {
    moveDialog.open = false
  }
}

async function reorder(direction: 'up' | 'down') {
  const department = selected.value
  if (department) await run(() => adminApi.reorderDepartment(department.id, direction), '已调整顺序')
}

async function removeDepartment() {
  const department = selected.value
  if (!department) return
  const reasons = [
    selectedChildren.value.length ? `还有 ${selectedChildren.value.length} 个下级部门` : '',
    directMemberIds.value.size ? `还有 ${directMemberIds.value.size} 名成员` : '',
  ].filter(Boolean)
  if (reasons.length) {
    await ElMessageBox.alert(`不能删除“${department.name}”：${reasons.join('，')}。请先移走下级部门和成员。`, '不能删除部门', { type: 'warning', confirmButtonText: '知道了' }).catch(() => undefined)
    return
  }
  const confirmed = await ElMessageBox.confirm(`确定删除部门“${department.name}”？`, '删除部门', {
    type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger',
  }).then(() => true).catch(() => false)
  if (confirmed) await run(() => adminApi.removeDepartment(department.id), `已删除部门“${department.name}”`)
}

function openAddMembers() {
  Object.assign(addDialog, { open: true, query: '', onlyUnassigned: false, picked: [] })
}

function toggleAllCandidates() {
  const ids = candidates.value.map(item => item.employee.id)
  addDialog.picked = allCandidatesPicked.value
    ? addDialog.picked.filter(id => !ids.includes(id))
    : [...new Set([...addDialog.picked, ...ids])]
}

async function saveMembers() {
  const department = selected.value
  if (!department || !addDialog.picked.length) return
  const count = addDialog.picked.length
  if (await run(() => adminApi.addDepartmentMembers(department.id, addDialog.picked), `已添加 ${count} 名成员`)) {
    addDialog.open = false
  }
}

async function setPrimary(employee: OrganizationEmployee) {
  const department = selected.value
  if (department) await run(() => adminApi.setPrimaryDepartment(department.id, employee.id), `${employee.name}的主部门已改为“${department.name}”`)
}

function openRemove(employee: OrganizationEmployee) {
  Object.assign(removeDialog, { open: true, user: employee, newPrimaryId: '' })
  removeDialog.newPrimaryId = removeOtherDepartments.value[0]?.id ?? ''
}

async function saveRemove() {
  const department = selected.value
  const user = removeDialog.user
  if (!department || !user) return
  const newPrimary = removeNeedsPrimary.value ? removeDialog.newPrimaryId : undefined
  if (await run(() => adminApi.removeDepartmentMember(department.id, user.id, newPrimary), `已将${user.name}移出“${department.name}”`)) {
    removeDialog.open = false
  }
}

onMounted(load)
</script>

<template>
  <div class="ops-page organization-page">
    <el-alert v-if="error" :title="error" type="error" show-icon @close="error = ''" />

    <template v-if="!snapshot.available">
      <section class="content-panel">
        <el-empty description="当前为 AI Hub 登录模式，组织架构不可用。组织架构只在独立账号登录模式下提供。" />
      </section>
    </template>

    <template v-else>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="部门由平台管理员维护。部门本身不带权限；员工的“部门”显示为其主部门。"
      />

      <section class="organization-summary">
        <article class="metric-card">
          <div class="metric-label">部门</div>
          <div class="metric-value">{{ departments.length }}</div>
          <div class="metric-detail">最多 {{ maxDepth }} 级</div>
        </article>
        <article class="metric-card">
          <div class="metric-label">已分配部门的员工</div>
          <div class="metric-value">{{ assignedCount }}</div>
          <div class="metric-detail">共 {{ snapshot.employees.length }} 名员工</div>
        </article>
        <article class="metric-card">
          <div class="metric-label">未分配部门的员工</div>
          <div class="metric-value">{{ unassignedCount }}</div>
          <div class="metric-detail">在“添加成员”中可只看未分配员工</div>
        </article>
      </section>

      <div class="organization-layout">
        <section class="content-panel content-panel--flush organization-tree" aria-label="部门树">
          <div class="panel-header">
            <strong>部门</strong>
            <span class="panel-meta">{{ departments.length }} 个</span>
          </div>
          <el-tree
            v-loading="loading"
            class="department-tree"
            :data="tree"
            node-key="id"
            :current-node-key="selected?.id"
            :expand-on-click-node="false"
            highlight-current
            default-expand-all
            @node-click="selectDepartment"
          >
            <template #default="{ data }">
              <span class="tree-node">
                <span class="tree-node__name">{{ data.label }}</span>
                <span class="tree-node__count">{{ data.count }}</span>
              </span>
            </template>
          </el-tree>
        </section>

        <div v-if="selected" class="organization-detail">
          <section class="content-panel department-header">
            <div class="department-header__copy">
              <span>{{ isRoot ? '根部门' : path(selected.id) }}</span>
              <h2>{{ selected.name }}</h2>
              <small>直属成员 {{ directMemberIds.size }} 人 · 含下级 {{ subtreeMemberIds.size }} 人 · 下级部门 {{ selectedChildren.length }} 个</small>
            </div>
            <div v-if="canManage" class="panel-actions department-header__actions">
              <el-button type="primary" :icon="Plus" :disabled="saving" @click="openName('create')">新建子部门</el-button>
              <el-button :disabled="saving" @click="openName('rename')">改名</el-button>
              <el-button :icon="ArrowUp" :disabled="saving || isRoot || siblingIndex <= 0" aria-label="上移" @click="reorder('up')" />
              <el-button :icon="ArrowDown" :disabled="saving || isRoot || siblingIndex === siblings.length - 1" aria-label="下移" @click="reorder('down')" />
              <el-button :disabled="saving || isRoot" @click="openMove">移动</el-button>
              <el-button type="danger" plain :disabled="saving || isRoot" @click="removeDepartment">删除</el-button>
            </div>
          </section>

          <section class="content-panel filter-panel">
            <div class="filter-bar">
              <el-input v-model="memberQuery" :prefix-icon="Search" clearable aria-label="搜索成员" placeholder="搜索姓名或账号" />
              <el-checkbox v-model="includeSub">包含下级部门成员</el-checkbox>
              <span class="filter-bar__meta">{{ memberRows.length }} 名员工</span>
              <el-button v-if="canManage" type="primary" :disabled="saving" @click="openAddMembers">添加成员</el-button>
            </div>
          </section>

          <section class="content-panel content-panel--flush">
            <el-table class="data-table" :data="memberRows" :empty-text="includeSub ? '本部门及下级部门都还没有成员' : '本部门还没有直属成员'">
              <el-table-column label="员工" min-width="200">
                <template #default="scope">
                  <div class="user-cell">
                    <span class="user-cell__avatar">{{ [...scope.row.employee.name][0] ?? '员' }}</span>
                    <span><strong>{{ scope.row.employee.name }}</strong><small>{{ scope.row.employee.email || '未提供邮箱' }}</small></span>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="登录账号" min-width="160" show-overflow-tooltip>
                <template #default="scope">{{ scope.row.employee.loginAccount ?? '—' }}</template>
              </el-table-column>
              <el-table-column label="所属部门" min-width="220">
                <template #default="scope">
                  <div class="tag-list">
                    <el-tag v-for="department in scope.row.departments" :key="department.id" effect="plain" :type="department.primary ? 'primary' : 'info'">
                      {{ department.name }}{{ department.primary ? ' · 主部门' : '' }}
                    </el-tag>
                  </div>
                </template>
              </el-table-column>
              <el-table-column v-if="canManage" label="操作" width="170" fixed="right">
                <template #default="scope">
                  <template v-if="scope.row.direct">
                    <el-button v-if="!scope.row.primaryHere" link type="primary" :disabled="saving" @click="setPrimary(scope.row.employee)">设为主部门</el-button>
                    <el-button link type="danger" :disabled="saving" @click="openRemove(scope.row.employee)">移出</el-button>
                  </template>
                  <span v-else class="empty-value">在下级部门</span>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </div>
      </div>
    </template>

    <el-dialog v-model="nameDialog.open" :title="nameDialog.mode === 'create' ? '新建部门' : '修改部门名称'" width="min(480px, calc(100vw - 32px))">
      <el-form label-position="top" @submit.prevent="saveName">
        <el-form-item label="部门名称" for="department-name" required :error="nameDialog.error">
          <el-input id="department-name" v-model="nameDialog.name" :maxlength="60" placeholder="例如：华东销售部" @input="nameDialog.error = ''" />
        </el-form-item>
        <p class="form-hint">{{ nameDialog.mode === 'create' ? `将建在“${selected?.name}”之下，之后可以移动。` : '改名不影响成员；以本部门为主部门的员工，显示部门同步更新。' }}</p>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="nameDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveName">{{ nameDialog.mode === 'create' ? '新建' : '保存' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="moveDialog.open" :title="`移动“${selected?.name}”`" width="min(520px, calc(100vw - 32px))">
      <el-form label-position="top">
        <el-form-item label="新的上级部门" for="move-target" required>
          <el-select id="move-target" v-model="moveDialog.targetId" filterable placeholder="选择上级部门">
            <el-option v-for="target in moveTargets" :key="target.id" :label="target.label" :value="target.id" />
          </el-select>
        </el-form-item>
        <p class="form-hint">本部门自己和它的下级部门不能作为新的上级，不在列表中。下级部门会一起移动。</p>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="moveDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!moveDialog.targetId" @click="saveMove">移动</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="addDialog.open" :title="`添加成员到“${selected?.name}”`" width="min(560px, calc(100vw - 32px))">
      <div class="add-members">
        <div class="add-members__filters">
          <el-input v-model="addDialog.query" :prefix-icon="Search" clearable aria-label="搜索员工" placeholder="搜索姓名或账号" />
          <el-checkbox v-model="addDialog.onlyUnassigned">只看未分配部门的员工</el-checkbox>
        </div>
        <div class="add-members__meta">
          <span>显示 {{ candidates.length }} 人，已选 {{ addDialog.picked.length }} 人</span>
          <el-button link type="primary" :disabled="!candidates.length" @click="toggleAllCandidates">{{ allCandidatesPicked ? '取消全选' : '全选当前列表' }}</el-button>
        </div>
        <el-checkbox-group v-model="addDialog.picked" class="candidate-list" aria-label="可添加的员工">
          <el-checkbox v-for="item in candidates" :key="item.employee.id" :value="item.employee.id" class="candidate">
            <span class="candidate__name"><strong>{{ item.employee.name }}</strong><small>{{ item.employee.loginAccount ?? '' }}</small></span>
            <el-tag effect="plain" :type="item.department ? 'info' : 'warning'">{{ item.department || '未分配部门' }}</el-tag>
          </el-checkbox>
          <el-empty v-if="!candidates.length" :image-size="56" description="没有可添加的员工" />
        </el-checkbox-group>
        <p class="form-hint">还没有部门的员工会以本部门为主部门；已有主部门的员工保持原主部门。</p>
      </div>
      <template #footer>
        <el-button :disabled="saving" @click="addDialog.open = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!addDialog.picked.length" @click="saveMembers">添加（{{ addDialog.picked.length }}）</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="removeDialog.open" title="移出部门" width="min(480px, calc(100vw - 32px))">
      <p class="dialog-copy">将{{ removeDialog.user?.name }}移出“{{ selected?.name }}”。</p>
      <el-form v-if="removeNeedsPrimary" label-position="top">
        <el-form-item label="新的主部门" for="new-primary" required>
          <el-select id="new-primary" v-model="removeDialog.newPrimaryId">
            <el-option v-for="option in removeOtherDepartments" :key="option.id" :label="option.label" :value="option.id" />
          </el-select>
        </el-form-item>
        <p class="form-hint">本部门是该员工的主部门，移出后需要指定新的主部门。</p>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="removeDialog.open = false">取消</el-button>
        <el-button type="danger" :loading="saving" :disabled="removeNeedsPrimary && !removeDialog.newPrimaryId" @click="saveRemove">移出</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.organization-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-section); }
.organization-layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--spacing-section); }
.organization-tree { flex: 1 1 260px; max-width: 320px; }
.organization-detail { display: flex; min-width: 0; flex: 999 1 560px; flex-direction: column; gap: 14px; }
.panel-header strong { color: var(--color-text-heading); font-size: var(--font-size-title); }
.panel-meta { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.department-tree { padding: 8px; }
.department-tree :deep(.el-tree-node__content) { height: 34px; border-radius: var(--radius-tag); }
.tree-node { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 8px; padding-right: 8px; }
.tree-node__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-node__count { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.department-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.department-header__copy { display: flex; min-width: 0; flex-direction: column; }
.department-header__copy span, .department-header__copy small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.department-header__copy h2 { margin: 2px 0 4px; color: var(--color-text-heading); font-size: var(--dsh-font-size-section); }
.department-header__actions { flex-wrap: wrap; }
.filter-bar .el-input { width: 260px; }
.user-cell { display: flex; min-width: 0; align-items: center; gap: 10px; }
.user-cell__avatar { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-weight: var(--font-weight-title); }
.user-cell > span:last-child { display: flex; min-width: 0; flex-direction: column; }
.user-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.user-cell small { margin-top: 3px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
.empty-value { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.form-hint { margin: 0; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.dialog-copy { margin: 0 0 12px; color: var(--color-text-primary); }
.add-members { display: flex; flex-direction: column; gap: 10px; }
.add-members__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.add-members__filters .el-input { flex: 1 1 200px; }
.add-members__meta { display: flex; align-items: center; justify-content: space-between; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.candidate-list { display: flex; max-height: 320px; flex-direction: column; overflow-y: auto; border: 1px solid var(--color-border); border-radius: var(--radius-tag); }
.candidate { display: flex; height: auto; min-height: 48px; margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--color-bg-subtle); }
.candidate :deep(.el-checkbox__label) { display: flex; min-width: 0; flex: 1; align-items: center; justify-content: space-between; gap: 10px; }
.candidate__name { display: flex; min-width: 0; flex-direction: column; }
.candidate__name strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.candidate__name small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
@media (max-width: 900px) { .organization-summary { grid-template-columns: 1fr; } .organization-tree { max-width: none; } .filter-bar .el-input { width: 100%; } }
</style>
