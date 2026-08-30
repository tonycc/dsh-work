import type { AttemptState, RunState } from './run-types.ts'

const transitions: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['running', 'cancel_requested', 'failed', 'cancelled'],
  running: ['cancel_requested', 'succeeded', 'failed', 'cancelled'],
  cancel_requested: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export function assertRunTransition(from: RunState, to: RunState) {
  if (from === to) return
  if (!transitions[from].includes(to)) throw new Error(`非法 Run 状态转换：${from} → ${to}`)
}

export function assertAttemptTransition(from: AttemptState, to: AttemptState) {
  assertRunTransition(from, to)
}

export function isTerminalState(status: RunState) {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}
