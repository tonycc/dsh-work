import type { App } from 'vue'

/**
 * 浏览器错误上报（错误记录方案 6.2，OBS-S1），员工端与管理端共用。
 *
 * - 捕获组件渲染错误、未处理的脚本错误与 Promise 拒绝、接口 5xx/超时/网络失败、失败提示、
 *   升级后分片加载失败与实时流放弃重连；
 * - 同一页面加载内同一问题只上报一次并计数，每次加载最多 20 个问题；
 * - 批量发送到 `/api/client-errors`，页面隐藏时用 `sendBeacon`；上报失败直接丢弃，不重试、不再触发上报；
 * - 失败提示只报错误码与提示模板（动作名），不报提示原文；不报请求体、页面文字与查询参数。
 */

export type ReportKind = 'render' | 'script' | 'promise' | 'api' | 'notice' | 'load' | 'stream'

export interface ErrorReport {
  kind: ReportKind
  message?: string
  stack?: string
  /** 前端路由名；不传时取当前路由名。 */
  route?: string
  traceId?: string
  runId?: string
  code?: string
  /** 仅失败提示：动作名等固定文案（如“发送消息”），不含用户内容。 */
  template?: string
}

interface QueuedReport extends ErrorReport { release?: string; count: number }

export interface ErrorReporterOptions {
  app: 'workbench' | 'admin'
  release?: string
  endpoint?: string
  /** 当前路由名（由路由器提供）。 */
  routeName?: () => string | undefined
  /** 测试替身；默认 `navigator.sendBeacon`，不可用时用 `fetch(keepalive)`。 */
  transport?: (url: string, body: string) => void
  flushDelayMs?: number
  maxProblems?: number
}

const TRACE_ID = /^trace-http-[0-9a-f-]{36}$/i
const SAFE = /^[A-Za-z0-9_.:-]{1,120}$/
const CODE = /^[A-Za-z0-9_]{1,80}$/
const TEMPLATE = /^[\p{Script=Han}A-Za-z0-9 _.:-]{1,40}$/u
const BATCH_SIZE = 20

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.length > max ? value.slice(0, max) : value
}

function defaultTransport(url: string, body: string) {
  try {
    const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' })
    if (typeof navigator !== 'undefined' && navigator.sendBeacon?.(url, blob)) return
    void fetch(url, { method: 'POST', body, keepalive: true, credentials: 'include', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
      .catch(() => undefined)
  } catch {
    // 上报失败直接丢弃。
  }
}

export class ErrorReporter {
  private readonly options: Required<Pick<ErrorReporterOptions, 'app' | 'endpoint' | 'flushDelayMs' | 'maxProblems'>> & ErrorReporterOptions
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, QueuedReport>()
  private queue: QueuedReport[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private reporting = false

  constructor(options: ErrorReporterOptions) {
    this.options = { endpoint: '/api/client-errors', flushDelayMs: 2_000, maxProblems: 20, ...options }
  }

  report(input: ErrorReport): void {
    if (this.reporting) return
    this.reporting = true
    try {
      const report = this.normalize(input)
      if (!report) return
      const key = [report.kind, report.code ?? '', report.template ?? '', report.route ?? '', (report.message ?? '').slice(0, 200), (report.stack ?? '').split('\n', 2)[1] ?? ''].join('|')
      const pending = this.pending.get(key)
      if (pending) {
        // 尚未发出：只累加次数。
        pending.count = Math.min(pending.count + 1, 1_000)
        return
      }
      if (!this.seen.has(key)) {
        if (this.seen.size >= this.options.maxProblems) return
        this.seen.add(key)
      }
      // 第一次出现，或上一批已发出后再次出现：新起一条，次数从 1 开始。
      this.pending.set(key, report)
      this.queue.push(report)
      this.schedule()
    } catch {
      // 上报器自身的问题不得影响页面。
    } finally {
      this.reporting = false
    }
  }

  /** 失败提示：只取错误码、动作名与链路编号。 */
  reportNotice(action: string, cause: unknown): void {
    const failure = (cause && typeof cause === 'object' ? cause : {}) as { code?: unknown; traceId?: unknown; status?: unknown }
    const status = typeof failure.status === 'number' ? failure.status : undefined
    // 5xx 已由接口层上报，这里只记员工看到的业务失败提示。
    if (status !== undefined && status >= 500) return
    this.report({
      kind: 'notice',
      code: typeof failure.code === 'string' ? failure.code : 'client_failure',
      template: action,
      traceId: typeof failure.traceId === 'string' ? failure.traceId : undefined,
    })
  }

  /** 接口失败：只报 5xx、超时与网络失败（4xx 是业务结果）。 */
  reportApiFailure(input: { status?: number; code?: string; traceId?: string; message?: string; networkError?: boolean }): void {
    if (!input.networkError && (input.status === undefined || input.status < 500)) return
    this.report({
      kind: 'api',
      message: input.networkError ? '网络请求失败' : `接口返回 ${input.status}`,
      code: input.code,
      traceId: input.traceId,
    })
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    while (this.queue.length) {
      const batch = this.queue.splice(0, BATCH_SIZE)
      const body = JSON.stringify({ app: this.options.app, reports: batch })
      const url = `${this.options.endpoint}?app=${this.options.app}`
      try {
        ;(this.options.transport ?? defaultTransport)(url, body)
      } catch {
        // 丢弃。
      }
    }
  }

  /** 接入 Vue 应用与全局事件。 */
  install(app: App): void {
    const previous = app.config.errorHandler
    app.config.errorHandler = (error, instance, info) => {
      this.report({ kind: 'render', message: errorMessage(error), stack: errorStack(error) })
      if (previous) previous(error, instance, info)
      else console.error(error)
    }
    if (typeof window === 'undefined') return
    window.addEventListener('error', event => {
      const target = event.target as Element | null
      if (target && target !== (window as unknown as Element) && 'tagName' in target) {
        const tag = target.tagName
        if (tag === 'SCRIPT' || tag === 'LINK') this.report({ kind: 'load', message: `${tag === 'SCRIPT' ? '脚本' : '样式'}加载失败` })
        return
      }
      this.report({ kind: 'script', message: event.message, stack: errorStack(event.error) })
    }, true)
    window.addEventListener('unhandledrejection', event => {
      this.report({ kind: 'promise', message: errorMessage(event.reason), stack: errorStack(event.reason) })
    })
    // 升级后旧页面加载新分片失败：提示刷新并上报（Vite 预加载失败事件）。
    window.addEventListener('vite:preloadError', () => {
      this.report({ kind: 'load', message: '页面资源加载失败（可能刚升级）' })
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush()
    })
    window.addEventListener('pagehide', () => this.flush())
  }

  private schedule() {
    if (this.queue.length >= BATCH_SIZE) { this.flush(); return }
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.options.flushDelayMs)
  }

  private normalize(input: ErrorReport): QueuedReport | null {
    const route = input.route ?? this.options.routeName?.()
    const report: QueuedReport = { kind: input.kind, count: 1 }
    if (input.kind !== 'notice') {
      const message = text(input.message, 2_000)
      const stack = text(input.stack, 16_000)
      if (message) report.message = message
      if (stack) report.stack = stack
    } else {
      const template = text(input.template, 40)
      if (template && TEMPLATE.test(template)) report.template = template
    }
    if (route && SAFE.test(route)) report.route = route
    if (input.traceId && TRACE_ID.test(input.traceId)) report.traceId = input.traceId
    if (input.runId && SAFE.test(input.runId)) report.runId = input.runId
    if (input.code && CODE.test(input.code)) report.code = input.code
    if (input.kind === 'notice' && !report.code) return null
    if (this.options.release) report.release = this.options.release.slice(0, 64)
    return report
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return typeof error === 'string' ? error : '未知错误'
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string' ? error.stack : undefined
}

let shared: ErrorReporter | undefined

/** 应用启动时创建一次；之后由 API 客户端、失败提示等通过 `errorReporter()` 使用。 */
export function setupErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  shared = new ErrorReporter(options)
  return shared
}

export function errorReporter(): ErrorReporter | undefined {
  return shared
}
