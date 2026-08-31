<script setup lang="ts">
import { ArrowRight, FolderOpened, Lock, UserFilled } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'

interface WorkspaceInfo {
  name: string
  description: string
  type: 'personal' | 'team'
  memberCount: number
  owner: string
  members: string[]
}

withDefaults(
  defineProps<{
    workspace: WorkspaceInfo
    dataScopes: string[]
    collapsible?: boolean
  }>(),
  {
    collapsible: false,
  },
)

const emit = defineEmits<{
  collapse: []
}>()

function memberInitial(name: string) {
  return Array.from(name)[0] ?? '成'
}
</script>

<template>
  <div class="workspace-info-panel">
    <header class="workspace-info-panel__header">
      <div>
        <span>{{ workspace.type === 'personal' ? '个人上下文' : '团队上下文' }}</span>
        <strong>工作空间信息</strong>
      </div>
      <button
        v-if="collapsible"
        class="workspace-info-panel__collapse"
        type="button"
        aria-label="收起工作空间信息"
        @click="emit('collapse')"
      >
        <el-icon><ArrowRight /></el-icon>
      </button>
    </header>

    <section class="workspace-info-panel__hero">
      <div class="workspace-info-panel__status">
        <span class="workspace-info-panel__folder"><el-icon><FolderOpened /></el-icon></span>
        <StatusTag status="neutral" :label="workspace.type === 'personal' ? '个人工作空间' : '团队工作空间'" />
      </div>
      <h2>{{ workspace.name }}</h2>
      <p>{{ workspace.description }}</p>
    </section>

    <dl class="workspace-info-panel__facts">
      <div>
        <dt>{{ workspace.type === 'personal' ? '空间归属' : '负责人' }}</dt>
        <dd>{{ workspace.type === 'personal' ? '仅你本人' : workspace.owner }}</dd>
      </div>
      <div>
        <dt>我的访问</dt>
        <dd>{{ workspace.type === 'personal' ? '本人 · 可发起对话' : '空间成员 · 可发起对话' }}</dd>
      </div>
      <div>
        <dt>企业数据范围</dt>
        <dd>{{ dataScopes.length ? dataScopes.join('、') : '按企业身份注入' }}</dd>
      </div>
    </dl>

    <div class="workspace-info-panel__permission-note">
      <el-icon><Lock /></el-icon>
      <span v-if="workspace.type === 'personal'">此处发起的对话自动归入你的个人空间，仅你可以访问；企业数据仍按当前身份权限提供。</span>
      <span v-else>此处发起的对话自动归入当前空间；工作空间只能收窄权限，不能扩大你的企业数据范围。</span>
    </div>

    <section v-if="workspace.type === 'team'" class="workspace-info-panel__section">
      <div class="workspace-info-panel__section-heading">
        <div>
          <h3>成员</h3>
          <span>{{ workspace.memberCount }} 人</span>
        </div>
      </div>
      <div class="workspace-member-list" :aria-label="`${workspace.name}成员`">
        <span
          v-for="(member, index) in workspace.members.slice(0, 5)"
          :key="member"
          class="workspace-member"
          :style="{ '--member-index': index }"
          :title="member"
        >
          {{ memberInitial(member) }}
        </span>
        <span v-if="workspace.memberCount > workspace.members.slice(0, 5).length" class="workspace-member workspace-member--more">
          +{{ workspace.memberCount - workspace.members.slice(0, 5).length }}
        </span>
        <span class="workspace-member-list__names">{{ workspace.members.join('、') }}</span>
      </div>
    </section>

    <footer class="workspace-info-panel__footer">
      <el-icon><UserFilled /></el-icon>
      {{ workspace.type === 'personal' ? '系统已为你创建唯一的默认个人空间' : '团队工作空间用于成员之间协作和内容归档' }}
    </footer>
  </div>
</template>

<style scoped>
.workspace-info-panel {
  height: 100%;
  padding: 19px 18px 24px;
  overflow-y: auto;
  color: #2c302d;
  background: #fafbf9;
}

.workspace-info-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e5e8e4;
}

.workspace-info-panel__header > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.workspace-info-panel__header span {
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
  letter-spacing: 0.08em;
}

.workspace-info-panel__header strong {
  margin-top: 3px;
  color: #252825;
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
}

.workspace-info-panel__collapse {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #747a75;
  background: transparent;
  cursor: pointer;
}

.workspace-info-panel__collapse:hover {
  color: #202420;
  background: #eceeeb;
}

.workspace-info-panel__hero {
  padding: 20px 2px 17px;
}

.workspace-info-panel__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-info-panel__folder {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 10px;
  color: #176750;
  background: #e8f5f0;
  font-size: var(--dsh-font-size-section);
}

.workspace-info-panel__hero h2 {
  margin: 15px 0 0;
  color: #202320;
  font-size: var(--dsh-font-size-section);
  font-weight: 680;
  letter-spacing: -0.025em;
}

.workspace-info-panel__hero p {
  margin: 7px 0 0;
  color: #747a75;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.65;
}

.workspace-info-panel__facts {
  margin: 0;
  padding: 3px 13px;
  border: 1px solid #e6e8e5;
  border-radius: 11px;
  background: #fff;
}

.workspace-info-panel__facts div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #eef0ed;
}

.workspace-info-panel__facts div:last-child {
  border-bottom: 0;
}

.workspace-info-panel__facts dt {
  color: #969b97;
  font-size: var(--dsh-font-size-badge);
}

.workspace-info-panel__facts dd {
  margin: 0;
  color: #454a46;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.5;
  text-align: right;
}

.workspace-info-panel__permission-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  border-radius: 9px;
  color: #517066;
  background: #edf6f2;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
}

.workspace-info-panel__permission-note .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.workspace-info-panel__section {
  margin-top: 22px;
}

.workspace-info-panel__section-heading,
.workspace-info-panel__section-heading > div {
  display: flex;
  align-items: center;
}

.workspace-info-panel__section-heading {
  justify-content: space-between;
  min-height: 29px;
  gap: 10px;
}

.workspace-info-panel__section-heading > div {
  gap: 7px;
}

.workspace-info-panel__section-heading h3 {
  margin: 0;
  color: #303430;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.workspace-info-panel__section-heading span {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.workspace-member-list {
  display: flex;
  min-width: 0;
  align-items: center;
  margin-top: 10px;
}

.workspace-member {
  display: grid;
  width: 29px;
  height: 29px;
  flex: 0 0 auto;
  margin-left: -5px;
  place-items: center;
  border: 2px solid #fafbf9;
  border-radius: 50%;
  color: #31443e;
  background: hsl(calc(155 + var(--member-index, 0) * 13) 40% 86%);
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.workspace-member:first-child {
  margin-left: 0;
}

.workspace-member--more {
  color: #6f756f;
  background: #e9ebe8;
}

.workspace-member-list__names {
  min-width: 0;
  margin-left: 9px;
  overflow: hidden;
  color: #777d78;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-info-panel__footer {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 24px;
  padding-top: 15px;
  border-top: 1px solid #e5e8e4;
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.workspace-info-panel__footer .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}
</style>
