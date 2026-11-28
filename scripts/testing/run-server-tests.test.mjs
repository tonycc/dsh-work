import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { classifyServerTest, descendantProcesses, listServerTests, countTests, parseShard, shardServerTests } from './run-server-tests.mjs'

test('server tests are classified by file name', () => {
  assert.equal(classifyServerTest('src/http/a.test.ts'), 'unit')
  assert.equal(classifyServerTest('config/dsh/policy.test.js'), 'unit')
  assert.equal(classifyServerTest('src/http/a.integration.test.ts'), 'integration')
  assert.equal(classifyServerTest('src/http/a.ts'), undefined)
  assert.equal(classifyServerTest('src/http/integration-helper.ts'), undefined)
})

test('server tests are selected by kind and directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-work-server-tests-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const file of [
    'src/modules/run/a.test.ts', 'src/modules/run/b.integration.test.ts', 'src/http/c.test.ts',
    'src/modules/run/node_modules/x.test.ts', 'config/dsh/d.test.js', 'dist/e.test.js',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), 'export {}\n')
  }
  assert.deepEqual(listServerTests(root, 'unit'), ['config/dsh/d.test.js', 'src/http/c.test.ts', 'src/modules/run/a.test.ts'])
  assert.deepEqual(listServerTests(root, 'integration'), ['src/modules/run/b.integration.test.ts'])
  assert.deepEqual(listServerTests(root, 'unit', ['src/modules/run']), ['src/modules/run/a.test.ts'])
  assert.throws(() => listServerTests(root, 'unit', ['dist']), /只能选择 server\/src 或 server\/config/)
  assert.throws(() => listServerTests(root, 'unit', ['src/missing']), /目录不存在/)
})

test('shards split files by weight so every file runs exactly once', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f']
  const sizes = { a: 90, b: 10, c: 40, d: 40, e: 15, f: 5 }
  const shards = [1, 2].map(index => shardServerTests(files, { index, total: 2 }, file => sizes[file]))
  assert.deepEqual(shards.flat().sort(), files)
  const loads = shards.map(shard => shard.reduce((sum, file) => sum + sizes[file], 0))
  assert.deepEqual(loads, [100, 100])
  // 分片内保持原有（字母）顺序。
  for (const shard of shards) assert.deepEqual(shard, [...shard].sort())
  assert.deepEqual(shardServerTests(files, { index: 1, total: 1 }), files)
  assert.equal(countTests("test('a', () => {})\n  test.skip('b', () => {})\n  it('c', () => {})\n// test('d')\nfoo.test('e')\n"), 3)
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 })
  assert.equal(parseShard(undefined), undefined)
  for (const invalid of ['0/2', '3/2', '1/0', '1', 'a/b']) assert.throws(() => parseShard(invalid), /--shard/)
})

test('runner CLI rejects unknown kinds and directories outside the server test roots', () => {
  const cli = resolve(import.meta.dirname, 'run-server-tests.mjs')
  assert.equal(spawnSync(process.execPath, [cli, 'e2e'], { encoding: 'utf8' }).status, 2)
  const outside = spawnSync(process.execPath, [cli, 'unit', '../e2e'], { encoding: 'utf8' })
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /只能选择/)
  const badShard = spawnSync(process.execPath, [cli, 'unit', '--shard=3/2'], { encoding: 'utf8' })
  assert.equal(badShard.status, 2)
  assert.match(badShard.stderr, /--shard/)
})

test('watchdog lists every process below the runner, including leaked grandchildren', () => {
  const ps = [
    '  1     0 /sbin/init',
    ' 10     1 node --test a.test.ts b.test.ts',
    ' 11    10 node --experimental-strip-types src/b.test.ts',
    ' 12    11 node /tmp/mock/docker.mjs run --name dsh-py-0',
    ' 13     1 node unrelated.js',
  ].join('\n')
  assert.deepEqual(descendantProcesses(ps, 10), [
    '11 node --experimental-strip-types src/b.test.ts',
    '12 node /tmp/mock/docker.mjs run --name dsh-py-0',
  ])
  assert.deepEqual(descendantProcesses(ps, 99), [])
})
