<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import EmployeeShell from '@/layouts/EmployeeShell.vue'

const route = useRoute()
const publicRoute = computed(() => Boolean(route.meta.public))
const shellRoute = computed(() => route.matched.length > 0 && !publicRoute.value)
</script>

<template>
  <router-view v-if="publicRoute" />
  <EmployeeShell v-else-if="shellRoute" />
</template>
