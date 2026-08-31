import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-agent-management-checklist.md',
  'server/migrations/0005_m4_agent_management.sql',
  'server/src/modules/agent/postgres-agent-service.ts',
  'server/src/http/admin/agent-routes.ts',
  'server/src/http/workbench/agent-routes.ts',
  'server/src/infrastructure/postgres/m4-agent-management.integration.test.ts',
  'apps/admin-web/src/views/AgentManagementView.vue',
  'apps/admin-web/src/components/AgentDraftDialog.vue',
  'apps/workbench-web/src/components/ConversationStarter.vue',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0005_m4_agent_management.sql'), 'utf8')
for (const table of ['agent_test_runs', 'agent_release_records']) {
  if (!migration.includes(`create table ${table}`)) failures.push(`M4-01 迁移缺少 ${table}`)
}
for (const column of ['active_version_id', 'draft_version_id', 'configuration_fingerprint']) {
  if (!migration.includes(column)) failures.push(`M4-01 迁移缺少 ${column}`)
}

const service = readFileSync(resolve(root, 'server/src/modules/agent/postgres-agent-service.ts'), 'utf8')
for (const method of ['createAgent(', 'updateAgent(', 'testAgent(', 'setStatus(', 'rollback(', 'listWorkbenchAgents(', 'getRuntimeSnapshot(']) {
  if (!service.includes(method)) failures.push(`Agent Service 缺少 ${method}`)
}
if (!service.includes('configuration_fingerprint')) failures.push('Agent 发布门禁缺少配置指纹')

const runtime = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
if (!runtime.includes('getRuntimeSnapshot')) failures.push('Run 编排尚未读取不可变 Agent Version 配置')

const runtimeOverlay = readFileSync(resolve(root, 'server/config/dsh/acp-managed-credentials.cordis.yml'), 'utf8')
if (!runtimeOverlay.includes('DSH_AGENT_SYSTEM_PROMPT')) failures.push('DSH 受管配置未注入 Agent System Prompt')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:agent', 'test:m4:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const adminContract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/agents', '/agents/draft', '/agents/test', '/agents/status', '/agents/rollback', '/agent-versions', '/agent-release-records']) {
  if (!adminContract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

const workbenchContract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-workbench.json'), 'utf8'))
if (!workbenchContract.paths?.['/agents']) failures.push('员工 API 缺少 /agents')

if (failures.length > 0) {
  console.error('M4-01 Agent 管理基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-01 Agent 管理基线验证通过：生命周期、版本、发布门禁、员工使用和 Runtime 配置齐全。')
