<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Bell, DataBoard, Lock, User } from '@element-plus/icons-vue'

import { roleLabels, useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()
const language = ref('zh-CN')
const outputDetail = ref('balanced')
const defaultArtifact = ref('xlsx')
const notifyFinished = ref(true)
const notifyApproval = ref(true)
const notifyFailed = ref(true)

function saveSettings() {
  ElMessage.success('原型设置已保存')
}
</script>

<template>
  <div class="page-container settings-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">用户中心</h1>
        <p class="page-description">查看企业身份和数据使用范围，并设置个人输出与通知偏好。</p>
      </div>
      <el-button type="primary" @click="saveSettings">保存设置</el-button>
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
          <div><dt>角色</dt><dd>{{ roleLabels[authStore.previewRole] }}</dd></div>
          <div class="identity-grid__wide"><dt>数据范围</dt><dd>{{ authStore.user.dataScopes.join('、') }}</dd></div>
        </dl>
      </section>

      <section class="panel settings-section">
        <div class="settings-section__heading">
          <span><el-icon><DataBoard /></el-icon></span>
          <div><h2>输出偏好</h2><p>作为新对话的默认偏好，不会覆盖提问中的明确要求</p></div>
        </div>
        <el-form class="settings-form" label-position="top">
          <el-form-item label="界面与回答语言">
            <el-select v-model="language">
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="英语" value="en" />
            </el-select>
          </el-form-item>
          <el-form-item label="回答详细程度">
            <el-radio-group v-model="outputDetail">
              <el-radio-button value="brief">简洁</el-radio-button>
              <el-radio-button value="balanced">平衡</el-radio-button>
              <el-radio-button value="detailed">详细</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="表格类成果默认格式">
            <el-select v-model="defaultArtifact">
              <el-option label="Excel（XLSX）" value="xlsx" />
              <el-option label="CSV" value="csv" />
              <el-option label="PDF" value="pdf" />
            </el-select>
          </el-form-item>
        </el-form>
      </section>

      <section class="panel settings-section">
        <div class="settings-section__heading">
          <span><el-icon><Bell /></el-icon></span>
          <div><h2>通知</h2><p>对话运行状态变化时通过站内通知提醒</p></div>
        </div>
        <div class="switch-list">
          <label><span><strong>回答完成</strong><small>本轮回答完成并生成结果时通知</small></span><el-switch v-model="notifyFinished" /></label>
          <label><span><strong>等待确认</strong><small>工具调用需要你确认时通知</small></span><el-switch v-model="notifyApproval" /></label>
          <label><span><strong>执行失败</strong><small>本轮执行失败并可以重试时通知</small></span><el-switch v-model="notifyFailed" /></label>
        </div>
      </section>

      <section class="panel settings-section privacy-section">
        <div class="settings-section__heading">
          <span><el-icon><Lock /></el-icon></span>
          <div><h2>数据使用说明</h2><p>企业数据访问遵循最小权限和全程审计</p></div>
        </div>
        <ul>
          <li>浏览器不会持有模型或企业系统的长期凭据。</li>
          <li>模型不能填写或覆盖你的用户身份、部门和数据范围。</li>
          <li>上传文件、业务对象查询和成果下载都会记录审计事件。</li>
          <li>共享工作空间不会让其他成员获得超出其原有范围的数据。</li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 15px;
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

.settings-form {
  padding: 16px 18px 3px;
}

.settings-form .el-select {
  width: 100%;
}

.switch-list {
  padding: 8px 18px 14px;
}

.switch-list label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  min-height: 58px;
  border-bottom: 1px solid #eef0f4;
}

.switch-list label:last-child {
  border-bottom: 0;
}

.switch-list label > span {
  display: flex;
  flex-direction: column;
}

.switch-list strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-caption);
  font-weight: 600;
}

.switch-list small {
  margin-top: 4px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.privacy-section ul {
  margin: 0;
  padding: 17px 22px 18px 38px;
  color: #536079;
  font-size: var(--dsh-font-size-caption);
  line-height: 2;
}

@media (max-width: 900px) {
  .settings-layout {
    grid-template-columns: 1fr;
  }
}
</style>
