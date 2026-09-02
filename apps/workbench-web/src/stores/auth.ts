import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { workbenchApi } from '../api/client'
import type { UserProfile, UserRole, WorkbenchSession } from '../types/domain'

export const roleLabels: Record<UserRole, string> = {
  employee: '普通员工',
  department_manager: '部门负责人',
  business_admin: '业务管理员',
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
  const error = ref('')
  const identityProvider = ref<WorkbenchSession['identityProvider'] | null>(null)
  const user = computed(() => sessionUser.value ?? loadingUser)
  const canAccessAdmin = computed(() =>
    ['business_admin', 'platform_admin', 'auditor'].includes(user.value.role),
  )
  let pendingLoad: Promise<void> | undefined

  async function load() {
    if (initialized.value) return
    if (pendingLoad) return pendingLoad
    pendingLoad = (async () => {
      loading.value = true
      error.value = ''
      try {
        const session = await workbenchApi.getSession()
        sessionUser.value = session.user
        identityProvider.value = session.identityProvider
        initialized.value = true
      } catch (cause) {
        sessionUser.value = null
        identityProvider.value = null
        error.value = cause instanceof Error ? cause.message : '登录会话加载失败'
        throw cause
      } finally {
        loading.value = false
        pendingLoad = undefined
      }
    })()
    return pendingLoad
  }

  function login(returnTo = currentReturnTo()) {
    window.location.assign(`/auth/workbench/login?return_to=${encodeURIComponent(returnTo)}`)
  }

  function logout() {
    sessionUser.value = null
    identityProvider.value = null
    initialized.value = false
    window.location.assign('/auth/workbench/logout')
  }

  return {
    user,
    canAccessAdmin,
    initialized,
    loading,
    error,
    identityProvider,
    load,
    login,
    logout,
  }
})

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
