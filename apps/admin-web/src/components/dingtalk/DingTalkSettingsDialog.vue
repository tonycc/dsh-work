<script setup lang="ts">
import { ElMessageBox } from 'element-plus'
import { reactive, ref, watch } from 'vue'

import { adminApi } from '@/api/client'
import type { DingTalkSettings } from '@/types/domain'

/**
 * 钉钉集成 › 应用配置的编辑对话框。保存时服务端先用这组凭据向钉钉换取 access_token，失败不保存。
 * AppSecret 不回显：已保存时留空即沿用；更换 CorpId 或 AppKey 时必须重新填写。
 */
const props = defineProps<{ settings: DingTalkSettings }>()
const open = defineModel<boolean>({ required: true })
const emit = defineEmits<{ saved: [DingTalkSettings] }>()

// 会话有效期、待绑定凭证有效期、每日代绑上限与接口超时改在“平台配置”中修改（运行参数配置方案 RP14），这里只编辑凭据。
const form = reactive({
  corpId: '', agentId: '', appKey: '', appSecret: '',
})
const saving = ref(false)
const error = ref('')

watch(open, value => {
  if (!value) return
  const settings = props.settings
  Object.assign(form, {
    corpId: settings.corpId ?? '', agentId: settings.agentId ?? '', appKey: settings.appKey ?? '', appSecret: '',
  })
  error.value = ''
}, { immediate: true })

function secretPlaceholder() {
  if (!props.settings.configured) return '首次配置须填写'
  if (props.settings.secretProblem === 'deployment_secret_missing') return '部署配置中已没有 AppSecret，请重新填写'
  if (!props.settings.secretReadable) return '已保存的 AppSecret 无法读取，请重新填写'
  return props.settings.secretHint ? `已保存（尾号 ${props.settings.secretHint}），留空不修改` : '已保存，留空不修改'
}

async function save() {
  const previousCorpId = props.settings.configured ? props.settings.corpId : null
  if (previousCorpId && form.corpId.trim() !== previousCorpId) {
    try {
      await ElMessageBox.confirm(
        `CorpId 由 ${previousCorpId} 改为 ${form.corpId.trim()}，即换到另一个钉钉企业。钉钉账号只在企业内唯一，保存后所有员工的钉钉绑定都会失效、钉钉内的登录立即退出，员工需在新企业的钉钉中重新绑定。`,
        '更换钉钉企业？', { confirmButtonText: '确认更换', cancelButtonText: '取消', type: 'warning', appendTo: 'body' },
      )
    } catch { return }
  }
  saving.value = true
  error.value = ''
  try {
    const saved = await adminApi.saveDingTalkSettings({
      corpId: form.corpId.trim(), agentId: form.agentId.trim(), appKey: form.appKey.trim(),
      ...(form.appSecret.trim() ? { appSecret: form.appSecret.trim() } : {}),
    })
    form.appSecret = ''
    open.value = false
    emit('saved', saved)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog v-model="open" title="编辑钉钉应用配置" width="min(560px, calc(100vw - 32px))" :close-on-click-modal="false" append-to-body @closed="form.appSecret = ''">
    <el-alert v-if="!settings.canStoreSecret" type="warning" :closable="false" show-icon title="服务未配置凭据主密钥 DSH_CREDENTIAL_MASTER_KEY，不能在页面保存 AppSecret。请联系部署人员配置后重启。" />
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" role="alert" />
    <el-form label-position="top" class="dingtalk-settings-form" @submit.prevent="save">
      <p class="dingtalk-settings-form__hint">在钉钉开放平台“企业内部应用”的凭证页获取。保存时会先用这组凭据连接钉钉，连接失败不会保存。</p>
      <el-form-item label="CorpId（企业 ID）" for="dingtalk-corp-id" required>
        <el-input id="dingtalk-corp-id" v-model="form.corpId" autocomplete="off" :maxlength="64" :disabled="saving" />
      </el-form-item>
      <el-form-item label="AgentId" for="dingtalk-agent-id" required>
        <el-input id="dingtalk-agent-id" v-model="form.agentId" autocomplete="off" :maxlength="64" :disabled="saving" />
      </el-form-item>
      <el-form-item label="AppKey（Client ID）" for="dingtalk-app-key" required>
        <el-input id="dingtalk-app-key" v-model="form.appKey" autocomplete="off" :maxlength="128" :disabled="saving" />
      </el-form-item>
      <el-form-item label="AppSecret（Client Secret）" for="dingtalk-app-secret" :required="!settings.configured">
        <el-input id="dingtalk-app-secret" v-model="form.appSecret" type="password" show-password autocomplete="new-password" :maxlength="512" :placeholder="secretPlaceholder()" :disabled="saving || !settings.canStoreSecret" />
        <p class="dingtalk-settings-form__hint">加密保存，保存后不再显示。更换 CorpId 或 AppKey 时须重新填写。</p>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="open = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ saving ? '正在连接钉钉…' : '验证并保存' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dingtalk-settings-form { display: grid; gap: 4px; }
.dingtalk-settings-form__hint { margin: 4px 0 8px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
</style>
