import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-tool-connector-management-checklist.md',
  'server/migrations/0007_m4_tool_connector_management.sql',
  'server/src/modules/tool/postgres-tool-connector-service.ts',
  'server/src/http/admin/tool-routes.ts',
  'server/config/dsh/dsh-work-tool-policy.js',
  'server/config/dsh/dsh-work-tool-policy.test.js',
  'server/src/infrastructure/postgres/m4-tool-connector-management.integration.test.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0007_m4_tool_connector_management.sql'), 'utf8')
for (const capability of ['read', 'glob', 'grep']) {
  if (!migration.includes(`'${capability}'`)) failures.push(`M4-03 迁移缺少 ${capability} Tool`)
}
for (const marker of ['connector_health_checks', 'dsh_tool_name', 'approval_policy']) {
  if (!migration.includes(marker)) failures.push(`M4-03 迁移缺少 ${marker}`)
}

const service = readFileSync(resolve(root, 'server/src/modules/tool/postgres-tool-connector-service.ts'), 'utf8')
for (const method of ['getTools(', 'getConnectors(', 'setToolStatus(', 'updateToolPermissions(', 'checkConnector(', 'assertAvailableReferences(', 'resolveRuntimeToolNames(']) {
  if (!service.includes(method)) failures.push(`Tool Service 缺少 ${method}`)
}

const adapter = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
if (!adapter.includes('DSH_ALLOWED_TOOLS_JSON')) failures.push('Runtime Adapter 尚未注入 Tool Allowlist')
const policy = readFileSync(resolve(root, 'server/config/dsh/dsh-work-tool-policy.js'), 'utf8')
for (const marker of ['ctx.tools.guard', 'DSH_ALLOWED_TOOLS_JSON', 'new Set()']) {
  if (!policy.includes(marker)) failures.push(`DSH Tool 策略缺少 ${marker}`)
}

const contract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/tools', '/tools/status', '/tools/permissions', '/connectors', '/connectors/check']) {
  if (!contract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:tool', 'test:m4:tool:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M4-03 Tool/Connector 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-03 Tool/Connector 基线验证通过：三个 DSH 只读 Tool、强引用、健康联动和失败关闭 Allowlist 齐全。')
