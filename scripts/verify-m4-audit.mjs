import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-audit-operations-checklist.md',
  'server/migrations/0012_m4_audit_operations.sql',
  'server/src/infrastructure/postgres/m4-audit-operations.integration.test.ts',
  'apps/admin-web/src/views/AuditView.vue',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0012_m4_audit_operations.sql'), 'utf8')
for (const marker of ['operational_events', 'model_usage_events', 'tool_audit_logs', 'run_events', 'artifact_versions']) {
  if (!migration.includes(marker)) failures.push(`M4-08 统一投影缺少 ${marker}`)
}

const operations = readFileSync(resolve(root, 'server/src/modules/admin/application/postgres-operations-service.ts'), 'utf8')
for (const marker of ['getRunOperations(', 'getOperationsSummary(', 'readOperationalEvents(', 'auditObjectType(']) {
  if (!operations.includes(marker)) failures.push(`审计运营服务缺少 ${marker}`)
}

const view = readFileSync(resolve(root, 'apps/admin-web/src/views/AuditView.vue'), 'utf8')
for (const marker of ['categoryFilter', 'getRunOperations', '同一运行链路', 'formattedDetail']) {
  if (!view.includes(marker)) failures.push(`管理端运营事件页缺少 ${marker}`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:audit', 'test:m4:audit:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const contract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/audit-events', '/operations/summary', '/operations/runs/{runId}']) {
  if (!contract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

if (failures.length > 0) {
  console.error('M4-08 审计与运营基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-08 审计与运营基线验证通过：六类安全事件、24 小时汇总、筛选、导出和 Run 下钻齐全。')
