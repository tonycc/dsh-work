<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="ops-page not-found-page">
    <section class="content-panel">
      <el-result icon="warning" title="没有找到对应内容" sub-title="当前地址没有对应的管理后台页面。">
        <template #extra><el-button type="primary" @click="router.push('/overview')">返回运营概览</el-button></template>
      </el-result>
    </section>
  </div>
</template>

<style scoped>
.not-found-page { min-height: calc(100vh - var(--dsh-topbar-height) - 28px); justify-content: center; }
.not-found-page .content-panel { display: grid; min-height: 420px; place-items: center; }
</style>
