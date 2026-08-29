<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="page-container not-found-page">
    <el-result icon="warning" title="页面不存在" sub-title="当前地址没有对应的原型页面。">
      <template #extra><el-button type="primary" @click="router.push('/workbench')">返回工作台</el-button></template>
    </el-result>
  </div>
</template>

<style scoped>
.not-found-page {
  display: grid;
  min-height: calc(100vh - var(--dsh-topbar-height));
  place-items: center;
}
</style>
