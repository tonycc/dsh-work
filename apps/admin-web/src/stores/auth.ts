import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type { AdminRole, AdminUserProfile } from '../types/domain'

export const roleLabels: Record<AdminRole, string> = {
  platform_admin: '平台管理员',
  auditor: '安全审计员',
}

const previewUsers: Record<AdminRole, AdminUserProfile> = {
  platform_admin: {
    id: 'user-admin',
    name: '陈默',
    title: 'AI 平台管理员',
    department: '数字化中心',
    avatarText: '陈',
    role: 'platform_admin',
    dataScopes: ['平台配置'],
  },
  auditor: {
    id: 'user-auditor',
    name: '许宁',
    title: '安全审计员',
    department: '审计与合规部',
    avatarText: '许',
    role: 'auditor',
    dataScopes: ['审计日志', '脱敏业务元数据'],
  },
}

export const useAuthStore = defineStore('admin-auth', () => {
  const previewRole = ref<AdminRole>('platform_admin')
  const sessionUser = ref<AdminUserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const user = computed(() =>
    previewRole.value === 'platform_admin' && sessionUser.value
      ? sessionUser.value
      : previewUsers[previewRole.value],
  )
  const canAccessAdmin = computed(() => true)
  const canManage = computed(() => previewRole.value === 'platform_admin')
  const isAuditor = computed(() => previewRole.value === 'auditor')

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

  function switchRole(role: AdminRole) {
    previewRole.value = role
  }

  return {
    previewRole,
    user,
    canAccessAdmin,
    canManage,
    isAuditor,
    initialized,
    loading,
    load,
    switchRole,
  }
})
