import { createRouter, createWebHistory } from 'vue-router'

import { pinia } from '@/stores'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/overview' },
    { path: '/admin', redirect: '/overview' },
    { path: '/admin/overview', redirect: '/overview' },
    { path: '/admin/agents', redirect: '/agents' },
    { path: '/admin/capabilities', redirect: '/capabilities' },
    { path: '/admin/runtimes', redirect: '/runtimes' },
    { path: '/admin/sessions', redirect: '/sessions' },
    { path: '/admin/workspaces', redirect: '/workspaces' },
    { path: '/admin/model-usage', redirect: '/model-usage' },
    { path: '/admin/members', redirect: '/members' },
    { path: '/admin/permissions', redirect: '/permissions' },
    { path: '/admin/audit', redirect: '/audit' },
    { path: '/admin/health', redirect: '/health' },
    {
      path: '/overview',
      name: 'overview',
      component: () => import('@/views/AdminOverviewView.vue'),
      meta: { title: '运营概览', requiresAdmin: true },
    },
    {
      path: '/agents',
      name: 'agents',
      component: () => import('@/views/AgentManagementView.vue'),
      meta: { title: 'Agent 管理', requiresAdmin: true },
    },
    {
      path: '/capabilities',
      name: 'capabilities',
      component: () => import('@/views/CapabilityManagementView.vue'),
      meta: { title: 'Skill 与工具', requiresAdmin: true },
    },
    {
      path: '/model-usage',
      name: 'model-usage',
      component: () => import('@/views/ModelUsageView.vue'),
      meta: { title: '模型用量', requiresAdmin: true },
    },
    {
      path: '/runtimes',
      name: 'runtimes',
      component: () => import('@/views/RuntimeManagementView.vue'),
      meta: { title: 'Runtimes', requiresAdmin: true },
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/views/SessionManagementView.vue'),
      meta: { title: 'Session 列表', requiresAdmin: true },
    },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspaceManagementView.vue'),
      meta: { title: '工作空间', requiresAdmin: true },
    },
    {
      path: '/members',
      name: 'members',
      component: () => import('@/views/MemberManagementView.vue'),
      meta: { title: '成员管理', requiresAdmin: true },
    },
    {
      path: '/permissions',
      name: 'permissions',
      component: () => import('@/views/PermissionManagementView.vue'),
      meta: { title: '权限与数据范围', requiresAdmin: true },
    },
    {
      path: '/audit',
      name: 'audit',
      component: () => import('@/views/AuditView.vue'),
      meta: { title: '审计记录', requiresAdmin: true },
    },
    {
      path: '/health',
      name: 'health',
      component: () => import('@/views/SystemHealthView.vue'),
      meta: { title: '系统健康', requiresAdmin: true },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在' },
    },
  ],
})

router.beforeEach((to) => {
  const authStore = useAuthStore(pinia)
  if (to.meta.requiresAdmin && !authStore.canAccessAdmin) return { name: 'overview' }
  return true
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '管理后台')} · dsh-work`
})

export default router
