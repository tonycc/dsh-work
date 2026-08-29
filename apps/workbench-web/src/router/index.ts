import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/', redirect: '/workbench' },
    {
      path: '/workbench',
      name: 'workbench',
      component: () => import('@/views/WorkbenchView.vue'),
      meta: { title: '工作台', section: '员工工作台' },
    },
    {
      path: '/conversations/:id',
      name: 'conversation',
      component: () => import('@/views/ConversationView.vue'),
      meta: { title: '对话', section: '员工工作台' },
    },
    { path: '/tasks/:id', redirect: (to) => ({ name: 'conversation', params: { id: to.params.id } }) },
    {
      path: '/workspaces',
      name: 'workspaces',
      component: () => import('@/views/WorkspacesView.vue'),
      meta: { title: '工作空间', section: '员工工作台' },
    },
    {
      path: '/workspaces/:id',
      name: 'workspace-detail',
      component: () => import('@/views/WorkspaceDetailView.vue'),
      meta: { title: '工作空间', section: '员工工作台' },
    },
    { path: '/history', redirect: '/workbench' },
    {
      path: '/artifacts',
      name: 'artifacts',
      component: () => import('@/views/ArtifactsView.vue'),
      meta: { title: '我的成果', section: '员工工作台' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { title: '用户中心', section: '员工工作台' },
    },
    {
      path: '/admin/:pathMatch(.*)*',
      redirect: () => ({ name: 'workbench' }),
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '页面不存在', section: 'dsh-work' },
    },
  ],
})

router.afterEach((to) => {
  document.title = `${String(to.meta.title ?? '员工工作台')} · dsh-work`
})

export default router
