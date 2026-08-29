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

const previewUsers: Record<UserRole, UserProfile> = {
  employee: {
    id: 'user-linlan',
    name: '林岚',
    title: '供应链计划专员',
    department: '供应链管理部',
    avatarText: '林',
    role: 'employee',
    dataScopes: ['华东区', '工厂一'],
  },
  department_manager: {
    id: 'user-zhouqi',
    name: '周启',
    title: '供应链负责人',
    department: '供应链管理部',
    avatarText: '周',
    role: 'department_manager',
    dataScopes: ['供应链管理部', '全工厂'],
  },
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

export const useAuthStore = defineStore('workbench-auth', () => {
  const previewRole = ref<UserRole>('employee')
  const sessionUser = ref<UserProfile | null>(null)
  const initialized = ref(false)
  const loading = ref(false)
  const user = computed(() =>
    previewRole.value === 'employee' && sessionUser.value
      ? sessionUser.value
      : previewUsers[previewRole.value],
  )
  const canAccessAdmin = computed(() =>
    ['platform_admin', 'auditor'].includes(previewRole.value),
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

  function switchRole(role: UserRole) {
    previewRole.value = role
  }

  return {
    previewRole,
    user,
    canAccessAdmin,
    initialized,
    loading,
    load,
    switchRole,
  }
})
