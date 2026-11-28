import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ElMessage } from 'element-plus'

import { workbenchApi } from '../api/client'
import { handOffAuthExpired, isAndroidAppContainer } from '../container/android'
import { isDingTalkContainer } from '../container/dingtalk'
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
  /** Android App 内不提供管理后台入口与退出登录（移动端方案 M0：管理后台不进入移动端，退出由原生处理）。 */
  const inAndroidApp = isAndroidAppContainer()
  const canAccessAdmin = computed(() =>
    !inAndroidApp && ['business_admin', 'platform_admin', 'auditor'].includes(user.value.role),
  )
  const canLogout = computed(() =>
    !inAndroidApp && identityProvider.value !== null && identityProvider.value !== 'prototype-sso',
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
    if (handOffAuthExpired()) return
    window.location.assign(`/auth/workbench/login?return_to=${encodeURIComponent(returnTo)}`)
  }

  function switchAccount(returnTo = '/workbench') {
    window.location.assign(`/auth/workbench/switch-account?return_to=${encodeURIComponent(returnTo)}`)
  }

  async function logout() {
    if (inAndroidApp) return
    // 钉钉会话与密码会话同为本地会话，退出登录撤销该账号全部来源的会话（钉钉接入方案 4.3）。
    try {
      const response = await fetch('/auth/workbench/logout', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error('退出登录失败，请重试')
      // 钉钉容器内带 logged_out：登录页不再自动免登，否则刚退出就被重新登录。桌面端不变。
      window.location.assign(isDingTalkContainer() ? '/login?logged_out=1' : '/login')
    } catch (cause) {
      ElMessage.error(cause instanceof Error ? cause.message : '退出登录失败')
    }
  }

  return {
    user,
    canAccessAdmin,
    canLogout,
    inAndroidApp,
    initialized,
    loading,
    error,
    identityProvider,
    load,
    login,
    logout,
    switchAccount,
  }
})

function currentReturnTo() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}
