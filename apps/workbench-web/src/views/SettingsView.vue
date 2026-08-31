<script setup lang="ts">
import { User } from '@element-plus/icons-vue'

import { roleLabels, useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
</script>

<template>
  <div class="page-container settings-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">用户中心</h1>
        <p class="page-description">查看企业身份和当前账号的数据使用范围。</p>
      </div>
    </header>

    <div class="settings-layout">
      <section class="panel settings-section">
        <div class="settings-section__heading">
          <span><el-icon><User /></el-icon></span>
          <div><h2>企业身份</h2><p>身份由企业登录系统提供，不能在 dsh-work 中修改</p></div>
        </div>
        <dl class="identity-grid">
          <div><dt>姓名</dt><dd>{{ authStore.user.name }}</dd></div>
          <div><dt>员工编号</dt><dd class="mono">{{ authStore.user.id }}</dd></div>
          <div><dt>部门</dt><dd>{{ authStore.user.department }}</dd></div>
          <div><dt>角色</dt><dd>{{ roleLabels[authStore.user.role] }}</dd></div>
          <div class="identity-grid__wide"><dt>数据范围</dt><dd>{{ authStore.user.dataScopes.join('、') }}</dd></div>
        </dl>
      </section>

    </div>
  </div>
</template>

<style scoped>
.settings-layout {
  display: block;
}

.settings-section {
  overflow: hidden;
}

.settings-section__heading {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--dsh-color-border);
}

.settings-section__heading > span {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: #315dc4;
  background: #edf3ff;
}

.settings-section__heading h2 {
  margin: 0;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-body);
}

.settings-section__heading p {
  margin: 4px 0 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.identity-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 24px;
  margin: 0;
  padding: 10px 18px 17px;
}

.identity-grid div {
  padding: 11px 0;
  border-bottom: 1px solid #eef0f4;
}

.identity-grid__wide {
  grid-column: 1 / -1;
}

.identity-grid dt {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.identity-grid dd {
  margin: 5px 0 0;
  color: #344054;
  font-size: var(--dsh-font-size-caption);
  font-weight: 590;
}

</style>
