<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const authStore = useAuthStore()
const errorCode = computed(() => typeof route.query.code === 'string' ? route.query.code : 'authentication_failed')
const errorDescription = computed(() => ({
  access_denied: '你取消了授权，或 AI Hub 未允许该账号访问管理后台。',
  account_disabled: '该 AI Hub 账号已停用，请联系平台管理员。',
  permission_denied: '当前账号缺少管理后台访问权限。',
  invalid_callback: '登录回调参数不完整，请重新发起登录。',
  invalid_state: '登录会话已过期或状态校验失败，请重新登录。',
  session_unavailable: '暂时无法校验登录会话，请稍后重试。',
}[errorCode.value] ?? '登录没有完成，请重新发起 AI Hub 单点登录。'))
</script>

<template>
  <main class="auth-result-page">
    <el-result icon="error" title="AI Hub 登录失败" :sub-title="errorDescription">
      <template #extra>
        <el-button type="primary" @click="authStore.login('/overview')">重新登录</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.auth-result-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: var(--color-bg-page); }
</style>
