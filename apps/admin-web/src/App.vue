<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { AdminShell } from '@dsh-work/admin-components'
import { roleLabels, useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const routeTitle = computed(() => String(route.meta.title ?? '管理后台'))
const publicRoute = computed(() => Boolean(route.meta.public))
const shellRoute = computed(() => route.matched.length > 0 && !publicRoute.value)

function navigate(path: string) {
  void router.push(path)
}

function openWorkbench() {
  const baseUrl = (import.meta.env.VITE_WORKBENCH_URL || 'http://localhost:4174').replace(/\/$/, '')
  window.location.assign(`${baseUrl}/workbench`)
}

function logout() {
  authStore.logout()
}
</script>

<template>
  <router-view v-if="publicRoute" />
  <AdminShell
    v-else-if="shellRoute"
    :current-path="route.path"
    :route-title="routeTitle"
    :user-name="authStore.user.name"
    :avatar-text="authStore.user.avatarText"
    :role-label="roleLabels[authStore.user.role]"
    :can-logout="authStore.identityProvider === 'ai-hub-oidc'"
    :can-read-admin="authStore.canReadAdmin"
    :can-read-audit="authStore.canReadAudit"
    @navigate="navigate"
    @open-workbench="openWorkbench"
    @logout="logout"
  >
    <router-view />
  </AdminShell>
</template>
