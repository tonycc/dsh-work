<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
</script>

<template>
  <main class="auth-result-page">
    <el-result icon="warning" title="无权访问员工工作台" sub-title="请在 AI Hub 中为当前账号授予 dsh_work.workbench.use 权限后重新登录。">
      <template #extra>
        <el-button type="primary" @click="authStore.logout()">退出并重新选择账号</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.auth-result-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: var(--color-bg-page); }
</style>
