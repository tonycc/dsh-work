import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-notification-error-experience-checklist.md',
  'server/src/http/router-error-experience.test.ts',
  'server/src/infrastructure/postgres/m4-notification-error-experience.integration.test.ts',
  'apps/workbench-web/src/utils/feedback.ts',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const router = readFileSync(resolve(root, 'server/src/http/router.ts'), 'utf8')
for (const marker of ['classifyHttpError(', 'object:', 'suggestion:', 'traceId']) {
  if (!router.includes(marker)) failures.push(`统一 API 错误响应缺少 ${marker}`)
}

const repository = readFileSync(resolve(root, 'server/src/modules/workbench/application/postgres-conversation-repository.ts'), 'utf8')
for (const marker of ['ra.error_code as "errorCode"', 'toRunError(', 'TOOL_PERMISSION_DENIED', 'CONNECTOR_UNAVAILABLE', 'retryable']) {
  if (!repository.includes(marker)) failures.push(`运行失败投影缺少 ${marker}`)
}

const conversation = readFileSync(resolve(root, 'apps/workbench-web/src/views/ConversationView.vue'), 'utf8')
for (const marker of ['task.error.object', 'task.error.reason', 'task.error.suggestion', 'task.error.retryable', '自动确认中']) {
  if (!conversation.includes(marker)) failures.push(`员工端失败/确认体验缺少 ${marker}`)
}

const feedback = readFileSync(resolve(root, 'apps/workbench-web/src/utils/feedback.ts'), 'utf8')
for (const marker of ['await workbenchApi.downloadArtifact', 'notifyActionFailure(', '原因：', '下一步：']) {
  if (!feedback.includes(marker)) failures.push(`成果下载反馈缺少 ${marker}`)
}

const capability = readFileSync(resolve(root, 'apps/admin-web/src/views/CapabilityManagementView.vue'), 'utf8')
for (const marker of ['连接器异常：', '健康检查结果为', '下一步：']) {
  if (!capability.includes(marker)) failures.push(`连接器异常体验缺少 ${marker}`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:error', 'test:m4:error', 'test:m4:error:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

for (const contractPath of ['docs/contracts/openapi-workbench.json', 'docs/contracts/openapi-admin.json']) {
  const contract = JSON.parse(readFileSync(resolve(root, contractPath), 'utf8'))
  const required = contract.components?.schemas?.ErrorEnvelope?.properties?.error?.required ?? []
  for (const field of ['code', 'message', 'object', 'suggestion', 'traceId']) {
    if (!required.includes(field)) failures.push(`${contractPath} 错误契约缺少 ${field}`)
  }
}

if (failures.length > 0) {
  console.error('M4-09 通知和错误体验基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-09 通知和错误体验基线验证通过：运行失败、自动确认、连接器异常和成果下载均提供对象、原因与下一步。')
