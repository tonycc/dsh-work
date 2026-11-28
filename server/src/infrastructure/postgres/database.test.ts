import assert from 'node:assert/strict'
import { test } from 'node:test'

import { serverDatabaseConfiguration } from './database.ts'

test('服务端连接池默认 30 条连接、开启预编译并设置语句与等锁超时', () => {
  assert.deepEqual(serverDatabaseConfiguration('postgres://x', {}), {
    url: 'postgres://x',
    maxConnections: 30,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 10_000,
    prepare: true,
  })
})

test('环境变量可覆盖连接池参数，0 关闭超时', () => {
  assert.deepEqual(serverDatabaseConfiguration('postgres://x', {
    DSH_WORK_DATABASE_POOL_SIZE: '12',
    DSH_WORK_DATABASE_STATEMENT_TIMEOUT_MS: '0',
    DSH_WORK_DATABASE_LOCK_TIMEOUT_MS: ' 2500 ',
    DSH_WORK_DATABASE_PREPARE: 'false',
  }), {
    url: 'postgres://x',
    maxConnections: 12,
    statementTimeoutMs: 0,
    lockTimeoutMs: 2500,
    prepare: false,
  })
})

test('连接池参数非法时启动失败', () => {
  assert.throws(() => serverDatabaseConfiguration('postgres://x', { DSH_WORK_DATABASE_POOL_SIZE: '0' }), /DSH_WORK_DATABASE_POOL_SIZE/)
  assert.throws(() => serverDatabaseConfiguration('postgres://x', { DSH_WORK_DATABASE_POOL_SIZE: '3.5' }), /DSH_WORK_DATABASE_POOL_SIZE/)
  assert.throws(() => serverDatabaseConfiguration('postgres://x', { DSH_WORK_DATABASE_STATEMENT_TIMEOUT_MS: 'abc' }), /STATEMENT_TIMEOUT/)
  assert.throws(() => serverDatabaseConfiguration('postgres://x', { DSH_WORK_DATABASE_PREPARE: 'yes' }), /DSH_WORK_DATABASE_PREPARE/)
})
