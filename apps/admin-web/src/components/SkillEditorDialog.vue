<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'

import { useContentStore } from '@/stores/content'
import type { SkillConfiguration, SkillDefinition } from '@/types/domain'

type SkillFormData = Omit<SkillConfiguration, 'id'>

const props = defineProps<{ skill?: SkillDefinition }>()
const emit = defineEmits<{ saved: [skill: SkillDefinition] }>()
const dialogOpen = defineModel<boolean>({ default: false })

const contentStore = useContentStore()
const formRef = ref<FormInstance>()
const saving = ref(false)
const initialSnapshot = ref('')
const form = reactive<SkillFormData>(emptyForm())

const rules: FormRules = {
  name: [{ required: true, min: 2, max: 40, message: '请输入 2～40 个字符的 Skill 名称', trigger: 'blur' }],
  category: [{ required: true, message: '请选择或输入分类', trigger: 'change' }],
  description: [{ required: true, min: 10, max: 200, message: '请输入 10～200 个字符的说明', trigger: 'blur' }],
  instructions: [{ required: true, min: 20, max: 2000, message: '执行指令至少需要 20 个字符', trigger: 'blur' }],
  toolIds: [{ type: 'array', required: true, min: 1, message: '请至少选择一个工具', trigger: 'change' }],
  testPrompt: [{ required: true, min: 4, message: '请输入一个典型校验问题', trigger: 'blur' }],
}

const availableTools = computed(() => contentStore.tools.filter((tool) => tool.status === 'available'))
const title = computed(() => props.skill
  ? `${props.skill.status === 'draft' ? '编辑 Skill' : '创建 Skill 新版本'}：${props.skill.name}`
  : '创建 Skill')
const isDirty = computed(() => JSON.stringify(form) !== initialSnapshot.value)

watch(dialogOpen, (open) => {
  if (open) reset()
})

function emptyForm(): SkillFormData {
  return {
    name: '',
    category: '',
    description: '',
    instructions: '',
    toolIds: [],
    testPrompt: '',
  }
}

function reset() {
  const source = props.skill
    ? {
        name: props.skill.name,
        category: props.skill.category,
        description: props.skill.description,
        instructions: props.skill.instructions,
        toolIds: props.skill.toolIds.map(toVersionedToolReference),
        testPrompt: props.skill.testPrompt,
      }
    : emptyForm()
  Object.assign(form, source)
  initialSnapshot.value = JSON.stringify(form)
  formRef.value?.clearValidate()
}

function toVersionedToolReference(reference: string) {
  if (reference.lastIndexOf('@') > 0) return reference
  const tool = contentStore.tools.find((item) => item.id === reference)
  return `${reference}@${tool?.version ?? '1.0.0'}`
}

async function save() {
  try {
    await formRef.value?.validate()
  } catch {
    ElMessage.warning('仍有必填配置未完成')
    return
  }
  saving.value = true
  try {
    const payload: SkillFormData = { ...form, toolIds: [...form.toolIds] }
    const saved = props.skill
      ? await contentStore.updateSkill({ id: props.skill.id, ...payload })
      : await contentStore.createSkill(payload)
    initialSnapshot.value = JSON.stringify(form)
    dialogOpen.value = false
    emit('saved', saved)
    ElMessage.success(props.skill?.status === 'draft'
      ? 'Skill 草稿已保存'
      : props.skill ? 'Skill 新版本草稿已创建' : 'Skill 已创建，当前为草稿状态')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Skill 保存失败')
  } finally {
    saving.value = false
  }
}

function handleBeforeClose(done: () => void) {
  if (!isDirty.value || saving.value) {
    done()
    return
  }
  ElMessageBox.confirm('关闭后，本次尚未保存的 Skill 配置会丢失。', '放弃未保存的修改？', {
    confirmButtonText: '放弃修改',
    cancelButtonText: '继续编辑',
    type: 'warning',
  }).then(() => done()).catch(() => undefined)
}

function requestClose() {
  handleBeforeClose(() => {
    dialogOpen.value = false
  })
}
</script>

<template>
  <el-dialog
    v-model="dialogOpen"
    class="capability-editor-dialog"
    :title="title"
    width="min(820px, calc(100vw - 48px))"
    top="5vh"
    :close-on-click-modal="false"
    :before-close="handleBeforeClose"
    destroy-on-close
  >
    <el-alert type="info" :closable="false" show-icon title="Skill 用于封装可复用的执行指令和工具组合；标识由系统自动生成，发布后当前版本不可原地修改。" />
    <el-form ref="formRef" class="capability-editor-form" :model="form" :rules="rules" label-position="top" status-icon>
      <div class="capability-form-grid">
        <el-form-item label="Skill 名称" prop="name"><el-input v-model="form.name" maxlength="40" show-word-limit placeholder="例如：订单交付风险分析" /></el-form-item>
        <el-form-item label="分类" prop="category">
          <el-select v-model="form.category" filterable allow-create default-first-option placeholder="选择或输入分类">
            <el-option v-for="category in ['知识', '供应链', '生产', '文件', '通用']" :key="category" :label="category" :value="category" />
          </el-select>
        </el-form-item>
      </div>
      <el-form-item label="Skill 说明" prop="description"><el-input v-model="form.description" type="textarea" :rows="3" maxlength="200" show-word-limit placeholder="说明适用场景、输入和输出" /></el-form-item>
      <el-form-item label="执行指令" prop="instructions">
        <el-input v-model="form.instructions" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="描述执行步骤、业务口径、边界条件和输出要求" />
        <p class="field-help">这里只存放可复用的业务执行规则，不要写入账号、密钥或连接参数。</p>
      </el-form-item>
      <el-form-item label="引用工具" prop="toolIds">
        <el-select v-model="form.toolIds" multiple filterable collapse-tags :max-collapse-tags="3" placeholder="选择 Skill 运行时允许调用的工具">
          <el-option v-for="tool in availableTools" :key="tool.id" :label="`${tool.name} · v${tool.version ?? '1.0.0'} · ${tool.system}`" :value="`${tool.id}@${tool.version ?? '1.0.0'}`" />
        </el-select>
      </el-form-item>
      <el-form-item label="发布校验问题" prop="testPrompt">
        <el-input v-model="form.testPrompt" placeholder="例如：分析本月订单交付风险" />
        <p class="field-help">发布时服务端会用此问题校验版本配置和引用关系。</p>
      </el-form-item>
    </el-form>
    <template #footer><el-button @click="requestClose">取消</el-button><el-button type="primary" :loading="saving" data-action="save-skill" @click="save">{{ props.skill ? '保存修改' : '完成创建' }}</el-button></template>
  </el-dialog>
</template>

<style scoped>
:global(.capability-editor-dialog.el-dialog) { display: flex; max-height: 90vh; flex-direction: column; overflow: hidden; }
:global(.capability-editor-dialog .el-dialog__body) { min-height: 0; overflow: auto; }
.capability-editor-form { margin-top: 18px; }
.capability-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.field-help { width: 100%; margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
:deep(.el-form-item) { margin-bottom: 20px; }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
:deep(.el-select) { width: 100%; }
@media (max-width: 680px) { .capability-form-grid { grid-template-columns: 1fr; } }
</style>
