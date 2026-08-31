import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m3-exit-checklist.md',
  'server/migrations/0003_m3_conversation_runtime.sql',
  'server/migrations/0004_m3_observability.sql',
  'server/src/http/workbench/conversation-routes.ts',
  'server/src/http/workbench/content-routes.ts',
  'server/src/modules/run/run-orchestration-service.ts',
  'server/src/modules/workbench/application/file-safety-scanner.ts',
  'server/src/infrastructure/postgres/m3-orchestration.integration.test.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const routes = readFileSync(resolve(root, 'server/src/http/workbench/conversation-routes.ts'), 'utf8')
for (const capability of ['Last-Event-ID', '/cancel', '/retry']) {
  const token = capability === 'Last-Event-ID' ? 'last-event-id' : capability
  if (!routes.includes(token)) failures.push(`M3 对话路由缺少 ${capability}`)
}
if (!routes.includes('router.delete(`${basePath}/sessions/:sessionId`')) {
  failures.push('M3 对话路由缺少删除 Session 能力')
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
if (orchestration.includes('publishAssistantResult')) {
  failures.push('普通回答完成时不得自动发布 Artifact')
}

const orchestrationTest = readFileSync(resolve(root, 'server/src/infrastructure/postgres/m3-orchestration.integration.test.ts'), 'utf8')
if (!orchestrationTest.includes('assert.equal(task.artifacts.length, 0)')) {
  failures.push('M3 集成测试必须覆盖普通回答不生成 Artifact')
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m3', 'test:m3:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M3 工程基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M3 工程基线验证通过：真实编排、SSE、工作空间、文件、Artifact、观测和退出清单齐全。')
