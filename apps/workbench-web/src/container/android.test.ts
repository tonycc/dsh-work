import { afterEach, describe, expect, it, vi } from 'vitest'

import { handOffAuthExpired, handOffFileSave, handOffPasswordChange, isAndroidAppContainer, type DshAndroidBridge } from './android'

const appAgent = 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/130 Mobile DshWorkAndroid/0.1.0'

function installBridge(): DshAndroidBridge {
  const native = { onAuthExpired: vi.fn(), onPasswordChangeRequired: vi.fn(), saveFile: vi.fn() }
  window.dshAndroid = native
  return native
}

describe('Android App container adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.dshAndroid
  })

  it('recognises the App only by its user agent token', () => {
    expect(isAndroidAppContainer(appAgent)).toBe(true)
    expect(isAndroidAppContainer('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile')).toBe(false)
    expect(isAndroidAppContainer('Mozilla/5.0 AliApp(DingTalk/7.6.0)')).toBe(false)
  })

  it('hands auth expiry, password changes and file saves to the native bridge', async () => {
    vi.stubGlobal('navigator', { userAgent: appAgent })
    const native = installBridge()
    expect(handOffAuthExpired()).toBe(true)
    expect(native.onAuthExpired).toHaveBeenCalledOnce()
    expect(handOffPasswordChange()).toBe(true)
    expect(native.onPasswordChangeRequired).toHaveBeenCalledOnce()
    expect(await handOffFileSave(new Blob(['你好'], { type: 'text/plain' }), '说明.txt')).toBe(true)
    expect(native.saveFile).toHaveBeenCalledWith('说明.txt', 'text/plain', '5L2g5aW9')
  })

  it('does nothing in a browser, even when a page defines the bridge object', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Chrome/130' })
    const native = installBridge()
    expect(handOffAuthExpired()).toBe(false)
    expect(handOffPasswordChange()).toBe(false)
    expect(await handOffFileSave(new Blob(['x']), 'x.txt')).toBe(false)
    expect(native.onAuthExpired).not.toHaveBeenCalled()
    expect(native.saveFile).not.toHaveBeenCalled()
  })

  it('falls back to the browser when the App has not injected the bridge', () => {
    vi.stubGlobal('navigator', { userAgent: appAgent })
    expect(handOffAuthExpired()).toBe(false)
  })
})
