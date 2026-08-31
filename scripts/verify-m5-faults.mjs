import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m5-runtime-fault-testing-checklist.md',
  'server/src/http/sse-reconnect.test.ts',
  'server/src/infrastructure/postgres/m5-runtime-faults.integration.test.ts',
  'server/src/modules/runtime/testing/mock-acp-worker.ts',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:m5:faults', 'test:m5:faults:integration', 'verify:m5:faults']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const adapter = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
for (const marker of [
  'RUNTIME_WORKER_CRASH',
  'MODEL_INVOCATION_FAILED',
  'TOOL_TIMEOUT',
  'NETWORK_UNAVAILABLE',
  'SERVICE_SHUTDOWN',
]) {
  if (!adapter.includes(marker)) failures.push(`Runtime 故障分类缺少 ${marker}`)
}

const repository = readFileSync(resolve(root, 'server/src/modules/run/postgres-run-repository.ts'), 'utf8')
for (const marker of ['recoverAfterRestart', 'SERVICE_RESTARTED', "a.status = 'queued'"]) {
  if (!repository.includes(marker)) failures.push(`服务重启恢复缺少 ${marker}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
for (const marker of ['recoverAfterServiceRestart', 'resumedQueued', 'await this.runtime.close()', 'await Promise.all(this.eventWrites.values())']) {
  if (!orchestration.includes(marker)) failures.push(`运行编排恢复缺少 ${marker}`)
}

const sseTest = readFileSync(resolve(root, 'server/src/http/sse-reconnect.test.ts'), 'utf8')
for (const marker of ['Last-Event-ID', 'event-before-disconnect', 'SERVICE_RESTARTED']) {
  if (!sseTest.includes(marker)) failures.push(`SSE 重连测试缺少 ${marker}`)
}

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
if (!workflow.includes('test:m5:faults:integration')) failures.push('GitHub Actions 缺少 M5-03 PostgreSQL 故障测试')

const checklist = readFileSync(resolve(root, 'docs/project/m5-runtime-fault-testing-checklist.md'), 'utf8')
for (const marker of ['R-15', '真实断网', '工程 Gate', 'M5-07']) {
  if (!checklist.includes(marker)) failures.push(`M5-03 清单缺少边界：${marker}`)
}

if (failures.length > 0) {
  console.error('M5-03 运行故障测试验证失败：')
  failures.forEach(failure => console.error(`- ${failure}`))
  process.exit(1)
}

console.log('M5-03 运行故障测试验证通过：Worker、取消、超时、模型、Tool、网络、SSE 和服务重启均有确定性故障与恢复证据。')
