import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { UserProfile, UserRole } from '../types/domain'

export const roleLabels: Record<UserRole, string> = {
  employee: '普通员工',
  department_manager: '部门负责人',
  platform_admin: '平台管理员',
  auditor: '安全审计员',
}

const loadingUser: UserProfile = {
  id: '—',
  name: '正在加载',
  title: '',
  department: '—',
  avatarText: '…',
  role: 'employee',
  dataScopes: [],
}

export const useAuthStore = defineStore('workbench-auth', () => {
  const sessionUser = ref<UserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const user = computed(() => sessionUser.value ?? loadingUser)
  const canAccessAdmin = computed(() =>
    ['platform_admin', 'auditor'].includes(user.value.role),
  )

  async function load() {
    if (initialized.value) return
    loading.value = true
    try {
      const session = await workbenchApi.getSession()
      sessionUser.value = session.user
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  return {
    user,
    canAccessAdmin,
    initialized,
    loading,
    load,
  }
})
