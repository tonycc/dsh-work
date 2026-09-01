import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 4180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4190',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://127.0.0.1:4190',
        changeOrigin: true,
      },
    },
  },
})
