/**
 * 升级后旧标签页的懒加载恢复，员工端与管理端共用。
 *
 * 升级前打开、没刷新的标签页仍运行上一版代码；切到还没加载过的页面时会请求上一版带哈希的代码块，
 * 新版 Release 里已没有这些文件（Nginx 对 `/assets/` 下缺失的文件返回 404）。这里识别这类失败，
 * 整页打开目标页面一次以换上新版入口页；sessionStorage 记下时间，短时间内不再重复刷新，
 * 避免资源确实缺失或网络异常时无限刷新——此时错误照常抛出，由页面和错误记录处理。
 */

/** 只用到路由器的这几个方法（不让共享包依赖 vue-router）。 */
export interface ChunkReloadRouter {
  beforeEach(guard: (to: { fullPath: string }) => unknown): unknown
  afterEach(guard: () => unknown): unknown
  onError(handler: (error: unknown, to: { fullPath: string }) => unknown): unknown
  resolve(to: string): { href: string }
}

export interface ChunkReloadOptions {
  /** 测试替身；默认 `window.sessionStorage`。 */
  storage?: () => Pick<Storage, 'getItem' | 'setItem'> | null
  /** 测试替身；默认 `window.location.assign`。 */
  navigate?: (href: string) => void
  now?: () => number
  /** 同一标签页两次自动刷新的最小间隔。 */
  windowMs?: number
}

export const CHUNK_RELOAD_STORAGE_KEY = 'dsh-work:chunk-reload-at'
const DEFAULT_WINDOW_MS = 30_000

/** Chromium、WebKit（Safari 与钉钉 iOS 容器）、Firefox 的动态导入失败消息，以及 Vite 的样式预加载失败。 */
const CHUNK_LOAD_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return CHUNK_LOAD_ERROR.test(message)
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.sessionStorage
}

/**
 * 打开 `href` 一次以换上新版代码；返回是否已发起。
 * 离线、存储不可用（无法防止循环）或刚刷新过时不刷新。
 */
export function reloadForStaleChunk(href: string, options: ChunkReloadOptions = {}): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const now = (options.now ?? Date.now)()
  try {
    const storage = (options.storage ?? defaultStorage)()
    if (!storage) return false
    const last = Number(storage.getItem(CHUNK_RELOAD_STORAGE_KEY))
    if (Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < (options.windowMs ?? DEFAULT_WINDOW_MS)) return false
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now))
  } catch {
    return false
  }
  ;(options.navigate ?? (target => window.location.assign(target)))(href)
  return true
}

/**
 * 接入路由与 Vite 预加载失败事件。
 *
 * - 路由懒加载失败：打开导航的目标页面（而不是刷新离开前的页面）；
 * - `vite:preloadError`（路由外的懒加载组件、样式等）：有进行中的导航时打开其目标，否则刷新当前页面；
 *   发起刷新时阻止 Vite 继续抛错，未发起时照常抛出。
 *
 * 在错误上报器 `install` 之后调用，页面卸载前的 `pagehide` 仍会把这次 `load` 记录发出。
 */
export function installChunkReloadRecovery(router: ChunkReloadRouter, options: ChunkReloadOptions = {}): void {
  let pendingHref: string | undefined
  router.beforeEach(to => {
    pendingHref = router.resolve(to.fullPath).href
  })
  router.afterEach(() => {
    pendingHref = undefined
  })
  router.onError((error, to) => {
    if (!isChunkLoadError(error)) return
    reloadForStaleChunk(to?.fullPath ? router.resolve(to.fullPath).href : currentHref(), options)
  })
  if (typeof window === 'undefined') return
  window.addEventListener('vite:preloadError', event => {
    if (reloadForStaleChunk(pendingHref ?? currentHref(), options)) event.preventDefault()
  })
}

function currentHref(): string {
  return window.location.href
}
