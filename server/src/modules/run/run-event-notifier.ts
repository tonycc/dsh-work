import { EventEmitter } from 'node:events'

/**
 * 进程内的 Run 事件唤醒信号（单进程部署）：事件落库提交后按 runId 发信号，正在等待的
 * SSE 连接立即读库。信号只负责唤醒，事件仍从 run_events 读取，所以 Last-Event-ID 续传、
 * 迟到事件过滤与逐批授权复核都不变；漏掉的信号（例如别的写入路径或另一个进程）由调用方
 * 的低频兜底轮询补上。
 */
const emitter = new EventEmitter()
// 每个打开的运行流各挂一个一次性监听；数量随在线流增长，不设上限告警。
emitter.setMaxListeners(0)

export function notifyRunEvent(runId: string): void {
  emitter.emit(runId)
}

/** 等到该 Run 有新事件信号或超时（两者先到为准）；`signal` 中止时立即返回。 */
export function waitForRunEvent(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      emitter.off(runId, done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    emitter.once(runId, done)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** 测试用：当前等待中的监听数。 */
export function runEventWaiterCount(runId: string): number {
  return emitter.listenerCount(runId)
}
