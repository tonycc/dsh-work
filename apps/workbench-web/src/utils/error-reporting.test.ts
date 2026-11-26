import { createApp, defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorReporter, setupErrorReporter } from '@dsh-work/ui-core'

import { notifyActionFailure } from './feedback'

// OBS-E2E-03：员工端异常与失败提示上报（上报器部分）。
const traceId = 'trace-http-7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a'

function captured(transport: ReturnType<typeof vi.fn>) {
  return transport.mock.calls.map(([url, body]) => ({ url: url as string, ...(JSON.parse(body as string) as { app: string; reports: Array<Record<string, unknown>> }) }))
}

describe('ErrorReporter', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('dedupes the same problem within a page load and counts repeats', () => {
    const transport = vi.fn()
    const reporter = new ErrorReporter({ app: 'workbench', release: '2026.11.26-01', transport, routeName: () => 'conversation' })
    for (let index = 0; index < 3; index += 1) reporter.report({ kind: 'render', message: 'TypeError: boom', stack: 'TypeError\n    at a (x.js:1:2)' })
    reporter.report({ kind: 'promise', message: 'other' })
    vi.advanceTimersByTime(2_000)
    const [batch] = captured(transport)
    expect(batch!.url).toBe('/api/client-errors?app=workbench')
    expect(batch!.reports).toEqual([
      { kind: 'render', count: 3, message: 'TypeError: boom', stack: 'TypeError\n    at a (x.js:1:2)', route: 'conversation', release: '2026.11.26-01' },
      { kind: 'promise', count: 1, message: 'other', route: 'conversation', release: '2026.11.26-01' },
    ])
    // 已发出后再次出现：只把新增次数再报一次。
    reporter.report({ kind: 'render', message: 'TypeError: boom', stack: 'TypeError\n    at a (x.js:1:2)' })
    vi.advanceTimersByTime(2_000)
    expect(captured(transport)[1]!.reports).toEqual([expect.objectContaining({ kind: 'render', count: 1 })])
  })

  it('caps distinct problems per page load', () => {
    const transport = vi.fn()
    const reporter = new ErrorReporter({ app: 'admin', transport, maxProblems: 2 })
    for (let index = 0; index < 5; index += 1) reporter.report({ kind: 'script', message: `problem ${index}` })
    reporter.flush()
    expect(captured(transport)[0]!.reports).toHaveLength(2)
  })

  it('reports only 5xx and network failures for API calls, with the trace id', () => {
    const transport = vi.fn()
    const reporter = new ErrorReporter({ app: 'workbench', transport })
    reporter.reportApiFailure({ status: 404, code: 'not_found' })
    reporter.reportApiFailure({ status: 500, code: 'operation_failed', traceId })
    reporter.reportApiFailure({ networkError: true })
    reporter.flush()
    expect(captured(transport)[0]!.reports).toEqual([
      { kind: 'api', count: 1, message: '接口返回 500', traceId, code: 'operation_failed' },
      { kind: 'api', count: 1, message: '网络请求失败' },
    ])
  })

  it('failure notices carry only the code, action and trace id — never the notice text', () => {
    const transport = vi.fn()
    setupErrorReporter({ app: 'workbench', transport, routeName: () => 'project-space' })
    const cause = Object.assign(new Error('张三的合同 13800138000 无权查看'), { code: 'forbidden', traceId, status: 403, object: '项目“机密”' })
    notifyActionFailure('打开项目', '项目“机密”', cause)
    notifyActionFailure('打开项目', '项目“机密”', Object.assign(new Error('x'), { status: 500, code: 'operation_failed' }))
    vi.advanceTimersByTime(2_000)
    const reports = captured(transport)[0]!.reports
    expect(reports).toEqual([{ kind: 'notice', count: 1, template: '打开项目', route: 'project-space', traceId, code: 'forbidden' }])
    expect(JSON.stringify(reports)).not.toContain('13800138000')
    expect(JSON.stringify(reports)).not.toContain('机密')
  })

  it('captures Vue render errors and never throws from reporting', () => {
    const transport = vi.fn(() => { throw new Error('network down') })
    const reporter = new ErrorReporter({ app: 'workbench', transport })
    const app = createApp(defineComponent({ render: () => { throw new Error('render failed') } }))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reporter.install(app)
    app.mount(document.createElement('div'))
    expect(() => reporter.flush()).not.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
    expect(JSON.parse(transport.mock.calls[0]![1] as string).reports[0]).toEqual(expect.objectContaining({ kind: 'render', message: 'Error: render failed' }))
    expect(errors).toHaveBeenCalled()
  })
})
