import assert from 'node:assert/strict'
import test from 'node:test'

import { assertRunTransition, isTerminalState } from './run-state-machine.ts'

test('run state machine accepts the happy path and cancellation path', () => {
  assert.doesNotThrow(() => assertRunTransition('queued', 'running'))
  assert.doesNotThrow(() => assertRunTransition('running', 'succeeded'))
  assert.doesNotThrow(() => assertRunTransition('running', 'cancel_requested'))
  assert.doesNotThrow(() => assertRunTransition('cancel_requested', 'cancelled'))
})

test('terminal run states cannot move backwards', () => {
  for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
    assert.equal(isTerminalState(state), true)
    assert.throws(() => assertRunTransition(state, 'running'), /非法 Run 状态转换/)
  }
})
