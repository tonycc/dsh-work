import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type { AdminRole, AdminUserProfile } from '../types/domain'

export const roleLabels: Record<AdminRole, string> = {
  platform_admin: '平台管理员',
  auditor: '安全审计员',
}

const loadingUser: AdminUserProfile = {
  id: '—',
  name: '正在加载',
  title: '',
  department: '—',
  avatarText: '…',
  role: 'auditor',
  dataScopes: [],
}

export const useAuthStore = defineStore('admin-auth', () => {
  const sessionUser = ref<AdminUserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const user = computed(() => sessionUser.value ?? loadingUser)
  const canAccessAdmin = computed(() => true)
  const canManage = computed(() => user.value.role === 'platform_admin')
  const isAuditor = computed(() => user.value.role === 'auditor')

  async function load() {
    if (initialized.value) return
    loading.value = true
    try {
      const session = await adminApi.getSession()
      sessionUser.value = session.user
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  return {
    user,
    canAccessAdmin,
    canManage,
    isAuditor,
    initialized,
    loading,
    load,
  }
})
