<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
</script>

<template>
  <main class="auth-result-page">
    <el-result icon="warning" title="无权访问此管理页面" sub-title="请在 AI Hub 中授予本页面所需的 dsh_work.admin.read 或 dsh_work.audit.read；写操作还需 dsh_work.admin.write。">
      <template #extra>
        <el-button type="primary" @click="authStore.logout()">退出并重新选择账号</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.auth-result-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: var(--color-bg-page); }
</style>
