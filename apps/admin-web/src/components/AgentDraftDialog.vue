<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'

import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentDraftConfiguration } from '@/types/domain'

const props = defineProps<{
  agent?: AgentDefinition
}>()

const emit = defineEmits<{
  saved: [agent: AgentDefinition]
}>()

const dialogOpen = defineModel<boolean>({ default: false })
const authStore = useAuthStore()
const contentStore = useContentStore()
const formRef = ref<FormInstance>()
const activeStep = ref(0)
const saving = ref(false)
const testing = ref(false)
const testPrompt = ref('')
const testedFingerprint = ref('')
const testResult = ref<{
  skill: string
  tools: string[]
  answer: string
} | null>(null)
const initialSnapshot = ref('')

const form = reactive<AgentDraftConfiguration>(emptyDraft())

const rules: FormRules = {
  name: [
    { required: true, message: '请输入 Agent 名称', trigger: 'blur' },
    { min: 2, max: 40, message: '名称长度为 2～40 个字符', trigger: 'blur' },
  ],
  description: [
    { required: true, message: '请输入 Agent 说明', trigger: 'blur' },
    { min: 10, max: 200, message: '说明长度为 10～200 个字符', trigger: 'blur' },
  ],
  systemPrompt: [
    { required: true, message: '请输入 System Prompt', trigger: 'blur' },
    { min: 20, message: 'System Prompt 至少需要 20 个字符', trigger: 'blur' },
  ],
  skills: [{ type: 'array', required: true, min: 1, message: '请至少引用一个已发布 Skill', trigger: 'change' }],
  tools: [{ type: 'array', required: true, min: 1, message: '请至少选择一个可用工具', trigger: 'change' }],
  roleIds: [{ type: 'array', required: true, min: 1, message: '请至少选择一个可见角色', trigger: 'change' }],
  dataScopes: [{ type: 'array', required: true, min: 1, message: '请至少配置一个业务数据范围', trigger: 'change' }],
}

const publishedSkills = computed(() => contentStore.skills.filter((skill) => skill.status === 'published'))
const usableTools = computed(() => contentStore.tools.filter((tool) => tool.status !== 'disabled'))
const dataScopeOptions = computed(() => unique([
  '继承员工角色与工作空间数据范围',
  '本部门汇总数据',
  '企业公开知识',
  '当前有效制度',
  ...contentStore.roles.flatMap((role) => role.dataScopes),
]))
const selectedRoleNames = computed(() => form.roleIds.map((id) => contentStore.roles.find((role) => role.id === id)?.name ?? id))
const selectedToolLabels = computed(() => form.tools.map((id) => contentStore.tools.find((tool) => tool.id === id)?.name ?? id))
const editorTitle = computed(() => props.agent ? `编辑 Agent：${props.agent.name}` : '创建 Agent')
const employeeWelcome = computed(() => form.welcomeMessage.trim() || buildWelcomeMessage(form.name, form.description))
const configurationFingerprint = computed(() => JSON.stringify({
  name: form.name,
  description: form.description,
  owner: form.owner,
  welcomeMessage: form.welcomeMessage,
  systemPrompt: form.systemPrompt,
  skills: form.skills,
  tools: form.tools,
  roleIds: form.roleIds,
  dataScopes: form.dataScopes,
  testPrompt: testPrompt.value,
}))
const testIsCurrent = computed(() => Boolean(testResult.value) && testedFingerprint.value === configurationFingerprint.value)
const isDirty = computed(() => JSON.stringify(form) !== initialSnapshot.value)

const stepFields: string[][] = [
  ['name', 'description'],
  ['systemPrompt', 'skills', 'tools', 'roleIds', 'dataScopes'],
]

watch(dialogOpen, (open) => {
  if (open) resetEditor()
})

function emptyDraft(): AgentDraftConfiguration {
  return {
    id: createAgentId(),
    name: '',
    description: '',
    owner: authStore.user.name,
    department: authStore.user.department,
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['继承员工角色与工作空间数据范围'],
    welcomeMessage: '',
    examplePrompts: ['请介绍你能提供哪些帮助'],
    systemPrompt: '',
    maxTokens: 12000,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    changeSummary: '创建初始草稿版本',
  }
}

function resetEditor() {
  const source = props.agent
    ? {
        id: props.agent.id,
        name: props.agent.name,
        description: props.agent.description,
        owner: props.agent.owner,
        department: props.agent.department,
        visibility: props.agent.visibility,
        roleIds: [...props.agent.roleIds],
        dataScopes: [...props.agent.dataScopes],
        welcomeMessage: props.agent.welcomeMessage,
        examplePrompts: [...props.agent.examplePrompts],
        systemPrompt: props.agent.systemPrompt,
        maxTokens: props.agent.maxTokens,
        timeoutSeconds: props.agent.timeoutSeconds,
        skills: [...props.agent.skills],
        tools: [...props.agent.tools],
        changeSummary: `更新 ${props.agent.name} 草稿配置`,
      }
    : emptyDraft()
  Object.assign(form, source)
  activeStep.value = 0
  testPrompt.value = source.examplePrompts[0] ?? '请介绍你能提供哪些帮助'
  testResult.value = null
  testedFingerprint.value = ''
  initialSnapshot.value = JSON.stringify(form)
  formRef.value?.clearValidate()
}

async function nextStep() {
  const fields = stepFields[activeStep.value] ?? []
  try {
    if (fields.length) await formRef.value?.validateField(fields)
    activeStep.value += 1
    if (activeStep.value === 2 && !testPrompt.value) testPrompt.value = '请介绍你能提供哪些帮助'
  } catch {
    ElMessage.warning('请先完成当前步骤的必填配置')
  }
}

function previousStep() {
  activeStep.value = Math.max(0, activeStep.value - 1)
}

async function runTest() {
  if (!testPrompt.value.trim()) {
    ElMessage.warning('请输入测试问题')
    return
  }
  testing.value = true
  await new Promise<void>((resolve) => setTimeout(resolve, 650))
  const matchedSkill = form.skills.find((skill) => testPrompt.value.includes(skill.slice(0, 2))) ?? form.skills[0]
  testResult.value = {
    skill: matchedSkill ?? '通用分析',
    tools: selectedToolLabels.value,
    answer: `已完成“${testPrompt.value.trim()}”的 Mock 验证。配置能够加载，角色与数据范围检查通过，实际发布前仍需连接模型和企业系统完成回归测试。`,
  }
  testedFingerprint.value = configurationFingerprint.value
  testing.value = false
  ElMessage.success('Mock 测试通过')
}

async function saveAgent() {
  try {
    await formRef.value?.validate()
  } catch {
    const firstInvalidStep = findFirstInvalidStep()
    if (firstInvalidStep >= 0) activeStep.value = firstInvalidStep
    ElMessage.warning('仍有必填配置未完成，请检查后再保存')
    return
  }

  if (!testIsCurrent.value) {
    activeStep.value = 2
    ElMessage.warning('请先使用当前配置完成 Mock 测试')
    return
  }

  saving.value = true
  try {
    const payload = preparePayload(form)
    const saved = props.agent
      ? await contentStore.updateAgentDraft(payload, authStore.user.name)
      : await contentStore.createAgentDraft(payload, authStore.user.name)
    initialSnapshot.value = JSON.stringify(form)
    dialogOpen.value = false
    emit('saved', saved)
    ElMessage.success(props.agent ? 'Agent 配置已保存' : 'Agent 已创建，当前为草稿状态')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Agent 保存失败')
  } finally {
    saving.value = false
  }
}

function findFirstInvalidStep() {
  if (!form.name || !form.description) return 0
  if (!form.systemPrompt || !form.skills.length || !form.tools.length || !form.roleIds.length || !form.dataScopes.length) return 1
  return -1
}

function handleBeforeClose(done: () => void) {
  if (!isDirty.value || saving.value) {
    done()
    return
  }
  ElMessageBox.confirm(
    '关闭后，本次尚未保存的 Agent 配置会丢失。',
    '放弃未保存的修改？',
    { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' },
  ).then(() => done()).catch(() => undefined)
}

function requestClose() {
  handleBeforeClose(() => {
    dialogOpen.value = false
  })
}

function cloneDraft(value: AgentDraftConfiguration): AgentDraftConfiguration {
  return {
    ...value,
    roleIds: [...value.roleIds],
    dataScopes: [...value.dataScopes],
    examplePrompts: [...value.examplePrompts],
    skills: [...value.skills],
    tools: [...value.tools],
  }
}

function preparePayload(value: AgentDraftConfiguration): AgentDraftConfiguration {
  const payload = cloneDraft(value)
  if (!props.agent) {
    payload.owner = authStore.user.name
    payload.department = authStore.user.department
  }
  payload.visibility = buildVisibilityLabel(payload.roleIds)
  payload.welcomeMessage = employeeWelcome.value
  payload.examplePrompts = [testPrompt.value.trim() || '请介绍你能提供哪些帮助']
  payload.changeSummary = props.agent ? `更新 ${payload.name} 配置` : '创建 Agent 初始版本'
  return payload
}

function createAgentId() {
  return `agent-${Date.now().toString(36)}`
}

function buildWelcomeMessage(name: string, description: string) {
  const agentName = name.trim() || '企业 Agent'
  const purpose = description.trim() || '我会根据已配置的能力和权限协助你完成工作。'
  return `你好，我是${agentName}。${purpose}`.slice(0, 120)
}

function buildVisibilityLabel(roleIds: string[]) {
  const names = roleIds.map((id) => contentStore.roles.find((role) => role.id === id)?.name ?? id)
  if (roleIds.includes('role-employee')) return '全体试点员工'
  return names.length > 1 ? `${names[0]}等 ${names.length} 个角色` : names[0] ?? '指定角色'
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}
</script>

<template>
  <el-dialog
    v-model="dialogOpen"
    class="agent-editor"
    :title="editorTitle"
    width="min(1040px, calc(100vw - 64px))"
    top="4vh"
    :close-on-click-modal="false"
    :before-close="handleBeforeClose"
    destroy-on-close
  >
    <div class="agent-editor__steps">
      <el-steps :active="activeStep" finish-status="success" align-center>
        <el-step title="定义 Agent" description="名称、说明和欢迎语" />
        <el-step title="配置能力和权限" description="Prompt、Skill、工具和权限" />
        <el-step :title="props.agent ? '测试并保存' : '测试并创建'" :description="props.agent ? '预览、Mock 测试并保存修改' : '预览、Mock 测试并完成创建'" />
      </el-steps>
    </div>

    <el-form ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
      <section v-show="activeStep === 0" class="agent-editor__pane" aria-label="Agent 基础信息">
        <header class="pane-heading">
          <div><h3>定义 Agent</h3><p>填写员工识别和理解 Agent 所需的基础信息。</p></div>
          <span class="step-badge">1 / 3</span>
        </header>
        <div v-if="props.agent" class="creator-owner" aria-label="Agent 负责人">
          <span class="creator-owner__avatar">{{ form.owner.slice(0, 1) }}</span>
          <div><small>负责人</small><strong>{{ form.owner }}</strong><p>{{ props.agent ? '负责人不随配置编辑变更，后续可通过移交流程调整。' : `当前创建者 · ${form.department}` }}</p></div>
          <el-tag effect="plain" round>{{ props.agent ? '当前负责人' : '自动设置' }}</el-tag>
        </div>
        <el-form-item label="Agent 名称" prop="name">
          <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="例如：质量异常分析助手" />
        </el-form-item>
        <el-form-item label="Agent 说明" prop="description">
          <el-input v-model="form.description" type="textarea" :rows="4" maxlength="200" show-word-limit placeholder="说明这个 Agent 面向谁、能够解决什么问题" />
        </el-form-item>
        <el-form-item label="欢迎语（选填）" prop="welcomeMessage">
          <el-input v-model="form.welcomeMessage" type="textarea" :rows="2" maxlength="120" show-word-limit placeholder="员工首次打开 Agent 时看到的欢迎语" />
          <p class="field-help">留空时，平台会根据 Agent 名称和说明自动生成欢迎语。</p>
        </el-form-item>
      </section>

      <section v-show="activeStep === 1" class="agent-editor__pane" aria-label="Agent 能力配置">
        <header class="pane-heading">
          <div><h3>配置能力和权限</h3><p>定义 Agent 如何工作，以及哪些员工可以在什么数据范围内使用。</p></div>
          <span class="step-badge">2 / 3</span>
        </header>
        <div class="configuration-section-heading"><strong>能力配置</strong><span>组合 System Prompt、Skill 和工具</span></div>
        <el-form-item label="System Prompt" prop="systemPrompt">
          <el-input v-model="form.systemPrompt" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="定义 Agent 的角色、目标、执行边界、输出要求和禁止事项" />
          <p class="field-help">不得包含凭证或密钥；发布后随 Agent 版本锁定。</p>
        </el-form-item>
        <div class="form-grid form-grid--two">
          <el-form-item label="引用 Skill" prop="skills">
            <el-select v-model="form.skills" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择已发布 Skill">
              <el-option v-for="skill in publishedSkills" :key="skill.id" :label="`${skill.name} · v${skill.version}`" :value="skill.name" />
            </el-select>
            <p class="field-help">仅允许引用已发布版本，运行时锁定具体版本。</p>
          </el-form-item>
          <el-form-item label="工具允许列表" prop="tools">
            <el-select v-model="form.tools" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择 Agent 可调用的工具">
              <el-option v-for="tool in usableTools" :key="tool.id" :label="`${tool.name} · ${tool.system}`" :value="tool.id" />
            </el-select>
            <p class="field-help">这里只声明允许列表，实际调用仍需通过员工和数据权限检查。</p>
          </el-form-item>
        </div>
        <div class="selection-overview">
          <div><span>Skill</span><strong>{{ form.skills.length }}</strong><small>个已选择</small></div>
          <div><span>工具</span><strong>{{ form.tools.length }}</strong><small>个已允许</small></div>
        </div>
        <div class="configuration-section-heading configuration-section-heading--permissions"><strong>权限配置</strong><span>Agent 权限只能收窄员工原有权限</span></div>
        <div class="form-grid form-grid--two">
          <el-form-item label="可见角色" prop="roleIds">
            <el-select v-model="form.roleIds" multiple filterable placeholder="选择可以使用此 Agent 的角色">
              <el-option v-for="role in contentStore.roles" :key="role.id" :label="`${role.name} · ${role.userCount} 人`" :value="role.id" />
            </el-select>
            <p class="field-help">未选中的角色不会在员工工作台看到此 Agent。</p>
          </el-form-item>
          <el-form-item label="数据范围" prop="dataScopes">
            <el-select v-model="form.dataScopes" multiple filterable allow-create default-first-option placeholder="选择或输入数据范围">
              <el-option v-for="scope in dataScopeOptions" :key="scope" :label="scope" :value="scope" />
            </el-select>
            <p class="field-help">最终权限取 Agent 范围、员工角色、工作空间和工具审批策略的交集。</p>
          </el-form-item>
        </div>
        <el-alert type="info" :closable="false" show-icon title="涉及敏感数据或写操作时，工具自身的审批策略仍然生效。" />
      </section>

      <section v-show="activeStep === 2" class="agent-editor__pane" aria-label="Agent 测试与创建">
        <header class="pane-heading">
          <div><h3>{{ props.agent ? '测试并保存' : '测试并创建' }}</h3><p>先确认员工端展示，再使用典型问题完成 Mock 测试。</p></div>
          <span class="step-badge">3 / 3</span>
        </header>
        <el-alert class="mock-notice" type="warning" :closable="false" show-icon title="当前为 Mock 测试，不调用真实模型、工具或企业系统。正式发布前仍需完成真实回归测试。" />
        <div class="test-grid">
          <section class="employee-preview">
            <h4>员工端展示预览</h4>
            <div class="employee-preview__frame">
              <header class="employee-preview__identity">
                <span class="employee-preview__avatar">d</span>
                <div><strong>{{ form.name || '未命名 Agent' }}</strong><small>{{ props.agent ? `由 ${form.owner} 维护` : '企业 Agent' }}</small></div>
                <el-tag effect="plain" round>Agent</el-tag>
              </header>
              <p class="employee-preview__description">{{ form.description || '填写 Agent 说明后，员工将在这里了解它能够解决的问题。' }}</p>
              <div class="employee-preview__message">{{ employeeWelcome }}</div>
              <div class="employee-preview__capabilities">
                <span v-for="skill in form.skills" :key="skill">{{ skill }}</span>
              </div>
              <small class="employee-preview__visibility">可见角色：{{ selectedRoleNames.join('、') || '未配置' }}</small>
            </div>
          </section>
          <section class="test-console">
            <h4>Mock 测试</h4>
            <el-input v-model="testPrompt" type="textarea" :rows="4" placeholder="输入一个典型员工问题" />
            <div class="test-console__action">
              <span>{{ testIsCurrent ? '当前配置已通过 Mock 测试' : testResult ? '配置已变更，需要重新测试' : '尚未测试' }}</span>
              <el-button type="primary" plain :loading="testing" @click="runTest">开始测试</el-button>
            </div>
            <article v-if="testResult" class="test-answer" :class="{ 'test-answer--stale': !testIsCurrent }">
              <strong>{{ form.name || 'Agent' }}</strong>
              <p>{{ testResult.answer }}</p>
              <small>命中 Skill：{{ testResult.skill }} · 调用工具：{{ testResult.tools.join('、') || '无' }}</small>
            </article>
            <el-empty v-else :image-size="48" description="运行一次测试后在这里查看结果" />
          </section>
        </div>
        <section class="draft-summary">
          <h4>{{ props.agent ? '修改内容确认' : '创建内容确认' }}</h4>
          <div class="draft-summary__grid" :class="{ 'draft-summary__grid--create': !props.agent }">
            <div><span>Agent</span><strong>{{ form.name }}</strong><small>{{ form.description }}</small></div>
            <div v-if="props.agent"><span>负责人</span><strong>{{ form.owner }}</strong><small>负责配置维护与发布</small></div>
            <div><span>能力</span><strong>{{ form.skills.length }} 个 Skill</strong><small>{{ form.tools.length }} 个工具</small></div>
            <div><span>权限</span><strong>{{ selectedRoleNames.length }} 个可见角色</strong><small>{{ form.dataScopes.length }} 个数据范围</small></div>
          </div>
        </section>
      </section>
    </el-form>

    <template #footer>
      <div class="agent-editor__footer">
        <el-button :disabled="saving" @click="requestClose">取消</el-button>
        <div>
          <el-button v-if="activeStep > 0" :disabled="saving" @click="previousStep">上一步</el-button>
          <el-button v-if="activeStep < 2" type="primary" @click="nextStep">下一步</el-button>
          <el-button v-else type="primary" :loading="saving" @click="saveAgent">{{ props.agent ? '保存修改' : '完成创建' }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.agent-editor.el-dialog) { display: flex; max-height: 92vh; flex-direction: column; overflow: hidden; }
:global(.agent-editor .el-dialog__body) { min-height: 0; overflow: auto; }
:global(.agent-editor .el-dialog__footer) { flex: 0 0 auto; border-top: 1px solid var(--color-border); }
.agent-editor__steps { padding: 4px 12px 22px; border-bottom: 1px solid var(--color-border); }
.agent-editor__pane { min-height: 500px; padding: 22px 8px 4px; }
.pane-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.pane-heading h3, .test-console h4, .employee-preview h4, .draft-summary h4 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.pane-heading p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.step-badge { padding: 4px 9px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.form-grid { display: grid; gap: 0 20px; }
.form-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-help { width: 100%; margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.creator-owner { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; margin-bottom: var(--spacing-card); padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.creator-owner__avatar { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-body); font-weight: var(--font-weight-title); }
.creator-owner > div { display: flex; min-width: 0; flex-direction: column; }
.creator-owner small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.creator-owner strong { margin-top: 2px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.creator-owner p { margin: 3px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.configuration-section-heading { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border); }
.configuration-section-heading strong { color: var(--color-text-heading); font-size: var(--font-size-body); }
.configuration-section-heading span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.configuration-section-heading--permissions { margin-top: 24px; }
.selection-overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.selection-overview > div { display: grid; grid-template-columns: 1fr auto; align-items: center; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.selection-overview span, .draft-summary span { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.selection-overview strong { color: var(--color-text-heading); font-size: var(--font-size-heading); }
.selection-overview small { grid-column: 1 / -1; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.mock-notice { margin-bottom: 16px; }
.test-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.test-console, .employee-preview, .draft-summary { padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.test-console h4, .employee-preview h4, .draft-summary h4 { margin-bottom: 14px; }
.employee-preview__frame { min-height: 270px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.employee-preview__identity { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.employee-preview__avatar { display: grid; width: 40px; height: 40px; place-items: center; border-radius: var(--radius-button); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.employee-preview__identity div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.employee-preview__identity strong { overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.employee-preview__identity small, .employee-preview__visibility { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.employee-preview__description { margin: 16px 0 12px; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
.employee-preview__message { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); color: var(--color-text-primary); background: var(--color-bg-base); font-size: var(--font-size-caption); line-height: 1.6; }
.employee-preview__capabilities { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.employee-preview__capabilities span { padding: 4px 8px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.test-console__action { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.test-answer { margin-top: 14px; padding: 14px; border: 1px solid var(--color-success); border-radius: var(--radius-button); background: var(--color-success-light); }
.test-answer--stale { border-color: var(--color-warning); background: var(--color-warning-light); }
.test-answer strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.test-answer p { margin: 7px 0 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.65; }
.test-answer small { display: block; margin-top: 9px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.draft-summary { margin-top: 16px; background: var(--color-bg-subtle); }
.draft-summary__grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.draft-summary__grid--create { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.draft-summary__grid > div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.draft-summary strong { overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.draft-summary small { overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.agent-editor__footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.agent-editor__footer > div { display: flex; gap: 8px; }
:deep(.el-form-item) { margin-bottom: 20px; }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
:deep(.el-select), :deep(.el-input-number) { width: 100%; }
:deep(.el-step__title) { font-size: var(--font-size-body); }
:deep(.el-step__description) { font-size: var(--font-size-badge); }
:deep(.el-empty) { padding: 24px 0 8px; }
@media (max-width: 800px) {
  .form-grid--two, .test-grid, .draft-summary__grid { grid-template-columns: 1fr; }
  .agent-editor__pane { min-height: 0; }
}
</style>
