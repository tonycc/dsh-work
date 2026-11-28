/**
 * Android App 容器适配层（移动端方案 M0「Android 容器模式」）。
 *
 * App 用 WebView 打开员工端时在 User-Agent 末尾追加 `DshWorkAndroid/<版本>`，并注入 `window.dshAndroid` 桥。
 * 与钉钉容器相同，识别只用于界面，不作为安全依据：身份仍由服务端按会话 Cookie 校验。
 * App 是唯一的登录入口，WebView 内不进入登录、改密页，不执行退出；会话失效、需要改密与文件保存都交给原生。
 */
export interface DshAndroidBridge {
  /** 会话失效（401）：原生回到登录页。 */
  onAuthExpired(): void
  /** 需要先修改初始密码：原生打开改密页。 */
  onPasswordChangeRequired(): void
  /** 保存文件：原生写入“下载”目录并提示打开。内容为 Base64（不含 data: 前缀）。 */
  saveFile(fileName: string, mimeType: string, base64: string): void
}

declare global {
  interface Window { dshAndroid?: DshAndroidBridge }
}

/** 是否运行在 dsh-work Android App 的 WebView 内（按 User-Agent，仅用于界面）。 */
export function isAndroidAppContainer(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return /\bDshWorkAndroid\/\d/.test(userAgent)
}

function bridge(): DshAndroidBridge | null {
  if (typeof window === 'undefined' || !isAndroidAppContainer()) return null
  return window.dshAndroid ?? null
}

/** 会话失效交给原生；不在 App 内时返回 false，由调用方走网页登录。 */
export function handOffAuthExpired() {
  const native = bridge()
  if (!native) return false
  native.onAuthExpired()
  return true
}

/** 需要改密交给原生；不在 App 内时返回 false。 */
export function handOffPasswordChange() {
  const native = bridge()
  if (!native) return false
  native.onPasswordChangeRequired()
  return true
}

/**
 * 文件保存交给原生：WebView 不能下载 `blob:` 地址。不在 App 内时返回 false，由调用方用浏览器下载。
 */
export async function handOffFileSave(blob: Blob, fileName: string) {
  const native = bridge()
  if (!native) return false
  native.saveFile(fileName, blob.type || 'application/octet-stream', await blobToBase64(blob))
  return true
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
