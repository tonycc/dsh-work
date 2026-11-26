import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHUNK_RELOAD_STORAGE_KEY, installChunkReloadRecovery, isChunkLoadError, reloadForStaleChunk } from '@dsh-work/ui-core'

import mainSource from '../main.ts?raw'

// 升级后旧标签页懒加载上一版代码块失败（Nginx 对缺失的 /assets/ 返回 404）时整页打开目标页面一次。
function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    values,
  }
}

const CHROMIUM = 'Failed to fetch dynamically imported module: https://work.example/assets/AdminOverviewView-Bq1x2y3z.js'
const WEBKIT = 'Importing a module script failed.'
const FIREFOX = 'error loading dynamically imported module: https://work.example/assets/ConversationView-old.js'

describe('isChunkLoadError', () => {
  it('recognises dynamic import failures across browsers and Vite CSS preload failures', () => {
    for (const message of [CHROMIUM, WEBKIT, FIREFOX, 'Unable to preload CSS for /assets/index-old.css']) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true)
    }
  })

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError({ code: 'forbidden', status: 403 })).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('reloadForStaleChunk', () => {
  it('navigates once and records the time in sessionStorage', () => {
    const storage = memoryStorage()
    const navigate = vi.fn()
    expect(reloadForStaleChunk('/agents', { storage: () => storage, navigate, now: () => 1_000_000 })).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/agents')
    expect(storage.values.get(CHUNK_RELOAD_STORAGE_KEY)).toBe('1000000')
  })

  it('does not reload again within the window, so a genuinely missing file cannot loop', () => {
    const storage = memoryStorage()
    const navigate = vi.fn()
    let now = 1_000_000
    const options = { storage: () => storage, navigate, now: () => now }
    expect(reloadForStaleChunk('/a', options)).toBe(true)
    now += 29_999
    expect(reloadForStaleChunk('/a', options)).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
    // 窗口过后（例如同一标签页又经历一次升级）可以再刷新一次。
    now += 1
    expect(reloadForStaleChunk('/a', options)).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(2)
  })

  it('does not reload when sessionStorage is unavailable or throws', () => {
    const navigate = vi.fn()
    expect(reloadForStaleChunk('/a', { storage: () => null, navigate })).toBe(false)
    const throwing = { getItem: () => { throw new Error('SecurityError') }, setItem: () => undefined }
    expect(reloadForStaleChunk('/a', { storage: () => throwing, navigate })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not reload while the browser is offline', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const navigate = vi.fn()
    expect(reloadForStaleChunk('/a', { storage: () => memoryStorage(), navigate })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    onLine.mockRestore()
  })
})

describe('installChunkReloadRecovery', () => {
  const listeners: Array<(event: Event) => void> = []
  const addEventListener = window.addEventListener.bind(window)
  afterEach(() => {
    for (const listener of listeners.splice(0)) window.removeEventListener('vite:preloadError', listener)
  })

  function setup(lazyError: unknown) {
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
      if (type === 'vite:preloadError') listeners.push(listener)
      addEventListener(type, listener, options)
    }) as typeof window.addEventListener)
    const router = createRouter({
      history: createMemoryHistory('/workbench/'),
      routes: [
        { path: '/', component: { template: '<div />' } },
        { path: '/agents/:id', component: () => Promise.reject(lazyError) },
      ],
    })
    const storage = memoryStorage()
    const navigate = vi.fn()
    installChunkReloadRecovery(router, { storage: () => storage, navigate })
    return { router, storage, navigate }
  }

  it('opens the navigation target (not the page being left) when a lazy route chunk is gone', async () => {
    const { router, navigate } = setup(new TypeError(CHROMIUM))
    await router.push('/')
    await expect(router.push('/agents/a1?tab=skills')).rejects.toThrow(CHROMIUM)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith('/workbench/agents/a1?tab=skills')
  })

  it('leaves other navigation errors alone', async () => {
    const { router, navigate } = setup(new Error('boom'))
    await router.push('/')
    await expect(router.push('/agents/a1')).rejects.toThrow('boom')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('handles vite:preloadError once and lets Vite rethrow when the guard blocks', () => {
    const { navigate } = setup(new Error('unused'))
    const first = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(first)
    expect(first.defaultPrevented).toBe(true)
    expect(navigate).toHaveBeenCalledWith(window.location.href)
    const second = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
  })
})

describe('workbench main.ts', () => {
  it('installs chunk reload recovery on the router after the error reporter', () => {
    expect(mainSource.indexOf('installChunkReloadRecovery(router)')).toBeGreaterThan(mainSource.indexOf('reporter.install(app)'))
  })
})
