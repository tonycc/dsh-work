<script setup lang="ts">
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
</script>

<template>
  <main class="auth-result-page">
    <el-result icon="warning" title="无权访问此管理页面" sub-title="请联系 dsh-work 应用管理员，在“员工与权限”中为当前账号配置所需的本地角色。">
      <template #extra>
        <el-button type="primary" @click="authStore.logout()">退出并重新选择账号</el-button>
      </template>
    </el-result>
  </main>
</template>

<style scoped>
.auth-result-page { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: var(--color-bg-page); }
</style>
