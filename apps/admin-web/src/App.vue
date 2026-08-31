<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { AdminShell } from '@dsh-work/admin-components'
import { roleLabels, useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const routeTitle = computed(() => String(route.meta.title ?? '管理后台'))

function navigate(path: string) {
  void router.push(path)
}

function openWorkbench() {
  const baseUrl = (import.meta.env.VITE_WORKBENCH_URL || 'http://localhost:4174').replace(/\/$/, '')
  window.location.assign(`${baseUrl}/workbench`)
}

onMounted(() => {
  void Promise.all([authStore.load(), contentStore.load()])
})
</script>

<template>
  <AdminShell
    :current-path="route.path"
    :route-title="routeTitle"
    :user-name="authStore.user.name"
    :avatar-text="authStore.user.avatarText"
    :role-label="roleLabels[authStore.user.role]"
    @navigate="navigate"
    @open-workbench="openWorkbench"
  >
    <router-view />
  </AdminShell>
</template>
