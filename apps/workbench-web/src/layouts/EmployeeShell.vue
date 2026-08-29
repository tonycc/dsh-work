<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Collection,
  Files,
  HomeFilled,
  Menu,
  Monitor,
  MoreFilled,
  Plus,
  Setting,
  SwitchButton,
  User,
} from '@element-plus/icons-vue'

import { AppLogo } from '@dsh-work/ui-core'
import { roleLabels, useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { UserRole } from '@/types/domain'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const taskStore = useTaskStore()
const contentStore = useContentStore()

const mobileOpen = ref(false)

const navigation = [
  { label: '工作台', path: '/workbench', icon: HomeFilled },
  { label: '工作空间', path: '/workspaces', icon: Collection },
  { label: '成果库', path: '/artifacts', icon: Files },
]

function isActive(path: string) {
  if (path === '/workbench') return route.path === path
  return route.path.startsWith(path)
}

function navigate(path: string) {
  mobileOpen.value = false
  void router.push(path)
}

function openAdmin() {
  const baseUrl = (import.meta.env.VITE_ADMIN_URL || 'http://localhost:4180').replace(/\/$/, '')
  window.location.assign(`${baseUrl}/overview`)
}

function onRoleCommand(command: string | number | object) {
  const value = String(command)
  if (value.startsWith('role:')) {
    const role = value.replace('role:', '') as UserRole
    authStore.switchRole(role)
    ElMessage.success(`已切换为${roleLabels[role]}视图`)
  }
  if (value === 'user-center') navigate('/settings')
  if (value === 'admin') openAdmin()
}

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  },
)

onMounted(() => {
  void Promise.all([authStore.load(), taskStore.load(), contentStore.load()])
})
</script>

<template>
  <div class="employee-shell">
    <button
      v-if="mobileOpen"
      class="sidebar-scrim"
      type="button"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    ></button>

    <aside class="employee-sidebar" :class="{ 'employee-sidebar--mobile-open': mobileOpen }">
      <div class="employee-sidebar__logo">
        <AppLogo dark />
        <el-tag class="prototype-tag" size="small" effect="plain">原型</el-tag>
      </div>

      <button class="new-conversation-button" type="button" @click="navigate('/workbench')">
        <el-icon><Plus /></el-icon>
        发起新对话
      </button>

      <nav class="employee-sidebar__nav" aria-label="员工工作台主导航">
        <p class="employee-sidebar__section-label">工作入口</p>
        <button
          v-for="item in navigation"
          :key="item.path"
          class="nav-item"
          :class="{ 'nav-item--active': isActive(item.path) }"
          type="button"
          @click="navigate(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <section class="employee-sidebar__recent">
        <div class="employee-sidebar__recent-title">最近对话</div>
        <button
          v-for="task in taskStore.recentTasks"
          :key="task.id"
          class="recent-conversation"
          type="button"
          @click="navigate(`/conversations/${task.id}`)"
        >
          <span class="recent-conversation__dot" :class="`recent-conversation__dot--${task.status}`"></span>
          <span class="recent-conversation__title">{{ task.title }}</span>
          <span class="recent-conversation__time">{{ task.updatedAt }}</span>
        </button>
      </section>

      <div class="employee-sidebar__footer">
        <div class="environment-status">
          <span class="environment-status__dot"></span>
          <span>最小可行产品演示环境</span>
          <span>原型接口</span>
        </div>
        <el-dropdown trigger="click" placement="top-start" @command="onRoleCommand">
          <button class="profile-button" type="button" aria-label="打开用户中心">
            <span class="profile-button__avatar">{{ authStore.user.avatarText }}</span>
            <span class="profile-button__copy">
              <strong>{{ authStore.user.name }}</strong>
              <small>{{ roleLabels[authStore.previewRole] }}</small>
            </span>
            <el-icon><MoreFilled /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu class="role-menu">
              <div class="role-menu__heading">用户中心</div>
              <el-dropdown-item command="user-center">
                <el-icon><Setting /></el-icon>
                个人资料与设置
              </el-dropdown-item>
              <div class="role-menu__heading">原型角色预览</div>
              <el-dropdown-item
                v-for="(label, role) in roleLabels"
                :key="role"
                :command="`role:${role}`"
                :class="{ 'is-current-role': authStore.previewRole === role }"
              >
                <el-icon><User /></el-icon>
                {{ label }}
              </el-dropdown-item>
              <el-dropdown-item v-if="authStore.canAccessAdmin" divided command="admin">
                <el-icon><Monitor /></el-icon>
                打开管理后台
              </el-dropdown-item>
              <el-dropdown-item disabled>
                <el-icon><SwitchButton /></el-icon>
                退出登录（原型）
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <div class="employee-shell__body">
      <el-button
        class="employee-mobile-menu"
        circle
        plain
        :icon="Menu"
        aria-label="打开导航"
        @click="mobileOpen = true"
      />
      <main class="employee-main"><router-view /></main>
    </div>
  </div>
</template>

<style scoped>
.employee-shell {
  --dsh-sidebar-width: 236px;
  min-height: 100vh;
  background: #fff;
}

.employee-sidebar {
  position: fixed;
  z-index: 30;
  inset: 0 auto 0 0;
  display: flex;
  width: var(--dsh-sidebar-width);
  flex-direction: column;
  overflow: hidden;
  color: #303236;
  border-right: 1px solid #e7e7e5;
  background: #f4f4f2;
}

.employee-sidebar__logo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  padding: 14px 15px 12px 18px;
}

.prototype-tag {
  --el-tag-border-color: #d9d9d6;
  --el-tag-bg-color: #ededeb;
  --el-tag-text-color: #73736f;
}

.new-conversation-button {
  display: flex;
  align-items: center;
  min-height: 40px;
  gap: 9px;
  margin: 3px 10px 14px;
  padding: 0 13px;
  border: 1px solid #dfdfdc;
  border-radius: 8px;
  color: #242528;
  background: #e7e7e4;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 70%);
  cursor: pointer;
  font-weight: 600;
}

.new-conversation-button:hover { background: #ddddda; }

.employee-sidebar__nav { padding: 0 8px; }

.employee-sidebar__section-label,
.employee-sidebar__recent-title {
  margin: 10px 10px 6px;
  color: #82827d;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.nav-item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 38px;
  gap: 10px;
  margin: 1px 0;
  padding: 0 11px;
  border: 0;
  border-radius: 8px;
  color: #464744;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.nav-item:hover { color: #20211f; background: #e9e9e6; }
.nav-item--active { color: #171817; background: #dededb; font-weight: 620; }
.nav-item .el-icon { width: 18px; font-size: var(--dsh-font-size-section); }

.employee-sidebar__recent {
  min-height: 0;
  flex: 1;
  margin-top: 15px;
  padding: 11px 8px;
  overflow: auto;
  border-top: 1px solid #e5e5e2;
}

.recent-conversation {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  gap: 7px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  color: #4d4e4b;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.recent-conversation:hover { color: #181918; background: #e9e9e6; }
.recent-conversation__dot { width: 5px; height: 5px; flex: 0 0 auto; border-radius: 50%; background: #858580; }
.recent-conversation__dot--running { background: #527ce2; }
.recent-conversation__dot--succeeded { background: #31a47d; }
.recent-conversation__dot--failed { background: #d05c67; }
.recent-conversation__dot--awaiting_approval { background: #d18a37; }
.recent-conversation__title { min-width: 0; flex: 1; overflow: hidden; font-size: var(--dsh-font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.recent-conversation__time { flex: 0 0 auto; color: #9a9a95; font-size: var(--dsh-font-size-micro); }

.employee-sidebar__footer { padding: 9px 9px 11px; border-top: 1px solid #e3e3e0; }
.environment-status { display: flex; align-items: center; gap: 7px; margin: 0 10px 8px; color: #858580; font-size: var(--dsh-font-size-badge); }
.environment-status span:last-child { margin-left: auto; }
.environment-status__dot { width: 6px; height: 6px; border-radius: 50%; background: #44bd92; }
.profile-button { display: flex; align-items: center; width: 100%; min-height: 48px; gap: 10px; padding: 6px 8px; border: 0; border-radius: 9px; color: #272825; background: transparent; cursor: pointer; text-align: left; }
.profile-button:hover { background: #e7e7e4; }
.profile-button__avatar { display: grid; width: 31px; height: 31px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: #124d3f; background: #bcebdc; font-size: var(--dsh-font-size-body); font-weight: 700; }
.profile-button__copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.profile-button__copy strong { font-size: var(--dsh-font-size-caption); font-weight: 620; }
.profile-button__copy small { margin-top: 2px; color: #858580; font-size: var(--dsh-font-size-badge); }
.employee-shell__body { min-width: 0; min-height: 100vh; margin-left: var(--dsh-sidebar-width); }
.employee-main { min-height: 100vh; background: #fff; }
.employee-mobile-menu { display: none; }
.sidebar-scrim { position: fixed; z-index: 25; inset: 0; display: none; border: 0; background: rgb(5 12 24 / 52%); }

:global(.role-menu__heading) { padding: 8px 16px 6px; color: #8a94a5; font-size: var(--dsh-font-size-caption); font-weight: 650; }
:global(.role-menu .is-current-role) { color: var(--dsh-color-brand); background: var(--dsh-color-brand-soft); }

@media (max-width: 820px) {
  .employee-sidebar { transform: translateX(-100%); box-shadow: 16px 0 40px rgb(5 12 24 / 22%); transition: transform 180ms ease; }
  .employee-sidebar--mobile-open { transform: translateX(0); }
  .sidebar-scrim { display: block; }
  .employee-shell__body { margin-left: 0; }
  .employee-mobile-menu { position: fixed; z-index: 18; top: 12px; left: 12px; display: inline-flex; border-color: #dfdfdc; background: rgb(255 255 255 / 90%); box-shadow: 0 4px 16px rgb(24 25 24 / 8%); backdrop-filter: blur(8px); }
}
</style>
