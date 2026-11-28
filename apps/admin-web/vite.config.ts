import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'

interface ServerPackageMetadata {
  releaseVersion?: string
}

interface RuntimeLockMetadata {
  version?: string
  commit?: string
  protocolVersion?: number
}

const serverPackage = JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8')) as ServerPackageMetadata
const runtimeLock = JSON.parse(readFileSync(new URL('../../server/config/dsh/runtime-lock.json', import.meta.url), 'utf8')) as RuntimeLockMetadata

function resolveBuildCommit() {
  const configured = process.env.GITHUB_SHA?.trim()
  if (configured && /^[0-9a-f]{40}$/i.test(configured)) return configured.toLowerCase()
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return '开发构建'
  }
}

const adminPort = Number(process.env.DSH_WORK_ADMIN_PORT ?? 4180)
const serverPort = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)

// 首包分包（前端首包体积优化）：Vue 运行时（vue / vue-router / pinia）拆成独立的长期缓存块，业务代码升级不使其失效。
// Element Plus 与图标库刻意不进手动分包：它们经 barrel 文件导出，整组分包会让 Rollup 把整库都打进来；
// 交给 Rollup 自动拆分后，只有实际用到的组件进入首屏或对应路由的代码块。
function manualChunks(id: string) {
  if (/[\\/]node_modules[\\/](@vue|vue|vue-router|pinia)[\\/]/.test(id)) return 'vendor-vue'
  return undefined
}

export default defineConfig({
  // 浏览器测试会同时启动多个同一应用的 Vite，各用各的依赖预构建缓存，避免并发写同一目录（见 playwright.config.ts）。
  ...(process.env.DSH_WORK_VITE_CACHE_DIR ? { cacheDir: process.env.DSH_WORK_VITE_CACHE_DIR } : {}),
  plugins: [
    vue(),
    // Element Plus 按需引入：模板里的 el-* 组件与 v-loading 指令按用到的引入；样式仍由 main.ts 整体引入，保证 base.css 的覆盖顺序不变。
    Components({
      dirs: [],
      dts: false,
      include: [/\.vue$/, /\.vue\?vue/],
      resolvers: [ElementPlusResolver({ importStyle: false })],
    }),
  ],
  define: {
    __DSH_WORK_RELEASE_VERSION__: JSON.stringify(serverPackage.releaseVersion ?? '开发构建'),
    __DSH_WORK_BUILD_COMMIT__: JSON.stringify(resolveBuildCommit()),
    __DSH_WORK_DSH_VERSION__: JSON.stringify(runtimeLock.version ?? '—'),
    __DSH_WORK_DSH_COMMIT__: JSON.stringify(runtimeLock.commit ?? '—'),
    __DSH_WORK_DSH_PROTOCOL_VERSION__: JSON.stringify(runtimeLock.protocolVersion ?? '—'),
  },
  // 源码映射只供服务端还原错误堆栈：不在产物中引用，发布时移出前端目录（错误记录方案 6.4）。
  build: { sourcemap: 'hidden', rollupOptions: { output: { manualChunks } } },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: adminPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
      '/auth': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
})
