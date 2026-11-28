import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresPersistentWaitService, persistentApprovalsEnabled } from './postgres-persistent-wait-service.ts'

test('持久化审批开关默认关闭，只认 true/false', () => {
  assert.equal(persistentApprovalsEnabled(undefined), false)
  assert.equal(persistentApprovalsEnabled(''), false)
  assert.equal(persistentApprovalsEnabled('false'), false)
  assert.equal(persistentApprovalsEnabled('0'), false)
  assert.equal(persistentApprovalsEnabled('true'), true)
  assert.equal(persistentApprovalsEnabled(' TRUE '), true)
  assert.equal(persistentApprovalsEnabled('1'), true)
  assert.throws(() => persistentApprovalsEnabled('yes'), /DSH_WORK_PERSISTENT_APPROVALS/)
})

test('关闭时不启动清扫，Attempt 终态不碰数据库', async () => {
  const database = new Proxy(() => { throw new Error('不应访问数据库') }, {
    get: () => () => { throw new Error('不应访问数据库') },
  })
  const service = new PostgresPersistentWaitService(
    database as never, {} as never,
    { reauthorize: async () => {}, enqueue: () => {} },
    'test', { enabled: false },
  )
  assert.equal(service.isEnabled, false)
  service.start()
  assert.equal((service as unknown as { sweepTimer?: unknown }).sweepTimer, undefined)
  assert.equal(await service.cancelPreparingForAttempt({ runId: 'run-1', attemptId: 'attempt-1' }), 0)
  service.close()
})
