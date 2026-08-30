<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Files, Search } from '@element-plus/icons-vue'

import { ArtifactCard } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import type { Artifact } from '@/types/domain'
import { workbenchApi } from '@/api/client'

const contentStore = useContentStore()
const query = ref('')
const typeFilter = ref('all')
const previewArtifact = ref<Artifact>()
const previewOpen = ref(false)

const filteredArtifacts = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.artifacts.filter((artifact) => {
    const matchesType = typeFilter.value === 'all' || artifact.type === typeFilter.value
    const matchesQuery = !keyword || `${artifact.name} ${artifact.summary}`.toLowerCase().includes(keyword)
    return matchesType && matchesQuery
  })
})

function preview(item: Artifact) {
  previewArtifact.value = item
  previewOpen.value = true
}

function download(item: Artifact) {
  const anchor = document.createElement('a')
  anchor.href = workbenchApi.artifactDownloadUrl(item.id, item.version)
  anchor.download = item.name
  anchor.click()
  ElMessage.success('已开始下载真实成果文件')
}

onMounted(() => contentStore.refresh())
</script>

<template>
  <div class="page-container artifacts-page">
    <header class="page-header">
      <div>
        <h1 class="page-title">我的成果</h1>
        <p class="page-description">集中查看对话生成的报告、表格与分析文件。每次更新形成新版本，并保留来源运行的追溯关系。</p>
      </div>
    </header>

    <section class="artifact-overview panel">
      <div class="artifact-overview__icon"><el-icon><Files /></el-icon></div>
      <div><strong>{{ contentStore.artifacts.length }}</strong><span>成果文件</span></div>
      <div><strong>{{ contentStore.artifacts.length }}</strong><span>当前已发布</span></div>
      <div><strong>实时</strong><span>PostgreSQL 索引</span></div>
      <p>成果继承工作空间权限，下载行为会进入审计记录。</p>
    </section>

    <div class="artifact-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索成果名称或内容摘要" />
      <el-select v-model="typeFilter" aria-label="成果类型">
        <el-option label="全部类型" value="all" />
        <el-option label="Excel" value="xlsx" />
        <el-option label="PDF" value="pdf" />
        <el-option label="Word" value="docx" />
        <el-option label="Markdown" value="markdown" />
      </el-select>
      <span>{{ filteredArtifacts.length }} 个文件</span>
    </div>

    <div v-if="contentStore.loading" class="artifact-grid">
      <div v-for="index in 4" :key="index" class="artifact-skeleton panel"><el-skeleton :rows="3" animated /></div>
    </div>
    <div v-else-if="filteredArtifacts.length" class="artifact-grid">
      <ArtifactCard
        v-for="artifact in filteredArtifacts"
        :key="artifact.id"
        :artifact="artifact"
        @preview="preview(artifact)"
        @download="download(artifact)"
      />
    </div>
    <el-empty v-else description="没有匹配的成果文件">
      <el-button @click="query = ''; typeFilter = 'all'">清除筛选</el-button>
    </el-empty>

    <el-dialog v-model="previewOpen" title="成果预览" width="min(720px, calc(100vw - 32px))">
      <div v-if="previewArtifact" class="artifact-preview">
        <div class="artifact-preview__paper">
          <small>DSH-WORK 成果 · V{{ previewArtifact.version }}</small>
          <h2>{{ previewArtifact.name }}</h2>
          <p>{{ previewArtifact.summary }}</p>
          <dl>
            <div><dt>来源运行</dt><dd class="mono">{{ previewArtifact.runId }}</dd></div>
            <div><dt>工作空间</dt><dd class="mono">{{ previewArtifact.workspaceId }}</dd></div>
            <div><dt>生成时间</dt><dd>{{ previewArtifact.createdAt }}</dd></div>
            <div><dt>文件大小</dt><dd>{{ previewArtifact.size }}</dd></div>
          </dl>
          <div class="artifact-preview__lines"><i v-for="n in 7" :key="n"></i></div>
        </div>
        <p class="artifact-preview__note">预览展示成果元数据；下载文件保留来源 Run 和不可覆盖版本。</p>
      </div>
      <template #footer>
        <el-button @click="previewOpen = false">关闭</el-button>
        <el-button v-if="previewArtifact" type="primary" :icon="Download" @click="download(previewArtifact)">下载成果</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.artifact-overview {
  display: grid;
  grid-template-columns: 50px repeat(3, minmax(100px, 150px)) minmax(220px, 1fr);
  align-items: center;
  gap: 18px;
  padding: 17px 20px;
}

.artifact-overview__icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border-radius: 11px;
  color: #315dc4;
  background: #edf3ff;
  font-size: var(--dsh-font-size-header);
}

.artifact-overview > div:not(:first-child) {
  display: flex;
  flex-direction: column;
  padding-right: 18px;
  border-right: 1px solid var(--dsh-color-border);
}

.artifact-overview strong {
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-section);
}

.artifact-overview span {
  margin-top: 3px;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.artifact-overview p {
  margin: 0;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
  text-align: right;
}

.artifact-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 19px 0 13px;
}

.artifact-toolbar .el-input {
  width: 310px;
}

.artifact-toolbar .el-select {
  width: 150px;
}

.artifact-toolbar > span {
  margin-left: auto;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
}

.artifact-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 11px;
}

.artifact-skeleton {
  padding: 16px;
}

.artifact-preview__paper {
  min-height: 370px;
  padding: 32px 38px;
  border: 1px solid #e0e4eb;
  background: #fff;
  box-shadow: 0 8px 30px rgb(30 50 90 / 7%);
}

.artifact-preview__paper > small {
  color: var(--dsh-color-brand);
  font-size: var(--dsh-font-size-micro);
  font-weight: 750;
  letter-spacing: 0.1em;
}

.artifact-preview__paper h2 {
  margin: 13px 0 7px;
  color: var(--dsh-color-ink);
  font-size: var(--dsh-font-size-header);
}

.artifact-preview__paper > p {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-caption);
  line-height: 1.6;
}

.artifact-preview__paper dl {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px 20px;
  margin: 23px 0;
}

.artifact-preview__paper dl div {
  display: flex;
  flex-direction: column;
}

.artifact-preview__paper dt {
  color: var(--dsh-color-subtle);
  font-size: var(--dsh-font-size-micro);
}

.artifact-preview__paper dd {
  margin: 4px 0 0;
  color: #44516a;
  font-size: var(--dsh-font-size-badge);
}

.artifact-preview__lines {
  display: grid;
  gap: 10px;
}

.artifact-preview__lines i {
  height: 8px;
  border-radius: 4px;
  background: #edf0f4;
}

.artifact-preview__lines i:nth-child(2n) {
  width: 78%;
}

.artifact-preview__note {
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-badge);
  text-align: center;
}

@media (max-width: 900px) {
  .artifact-overview {
    grid-template-columns: 46px repeat(3, 1fr);
  }

  .artifact-overview p {
    grid-column: 1 / -1;
    text-align: left;
  }

  .artifact-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .artifact-overview {
    grid-template-columns: 42px 1fr;
  }

  .artifact-overview > div:not(:first-child) {
    border-right: 0;
  }

  .artifact-overview p {
    grid-column: 1 / -1;
  }

  .artifact-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .artifact-toolbar .el-input,
  .artifact-toolbar .el-select {
    width: 100%;
  }

  .artifact-toolbar > span {
    margin-left: 0;
  }
}
</style>
