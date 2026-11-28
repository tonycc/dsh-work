import { createApp } from 'vue'
// Element Plus 组件按需引入（见 vite.config.ts）；样式整体引入并排在设计令牌与 base.css 之前，覆盖顺序不变。
import 'element-plus/dist/index.css'

import App from './App.vue'
import router from './router'
import { pinia } from './stores'
import '@dsh-work/design-tokens/tokens.css'
import '@dsh-work/ui-core/base.css'
import { installChunkReloadRecovery, setupErrorReporter } from '@dsh-work/ui-core'

const app = createApp(App)
// 错误记录（OBS-S1）：渲染错误、未处理异常、接口 5xx 与失败提示上报到平台，管理员在“错误记录”查看。
const reporter = setupErrorReporter({
  app: 'workbench',
  release: typeof __DSH_WORK_RELEASE_VERSION__ === 'undefined' ? undefined : __DSH_WORK_RELEASE_VERSION__,
  routeName: () => {
    const name = router.currentRoute.value.name
    return typeof name === 'string' ? name : undefined
  },
})
reporter.install(app)
// 使用情况（OBS-S2）：记录页面访问（路由名）。
reporter.trackRouter(router)
// 升级后旧标签页懒加载上一版代码块失败（Nginx 对缺失的 /assets/ 返回 404）：整页打开目标页面一次换上新版。
installChunkReloadRecovery(router)
app.use(pinia).use(router).mount('#app')
// index.html 中的启动检查据此判断应用已挂载（未挂载时上报白屏）。
;(window as Window & { __DSH_APP_MOUNTED__?: boolean }).__DSH_APP_MOUNTED__ = true
