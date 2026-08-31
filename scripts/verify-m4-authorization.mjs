import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-permission-data-scope-checklist.md',
  'server/migrations/0010_m4_authorization.sql',
  'server/src/modules/authorization/postgres-authorization-service.ts',
  'server/src/infrastructure/postgres/m4-authorization.integration.test.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0010_m4_authorization.sql'), 'utf8')
for (const marker of ['data_scope_grants', 'workspace_capability_grants', 'agent-version-dsh-work-assistant-1', 'tool-version-read-1']) {
  if (!migration.includes(marker)) failures.push(`M4-06 迁移缺少 ${marker}`)
}

const authorization = readFileSync(resolve(root, 'server/src/modules/authorization/postgres-authorization-service.ts'), 'utf8')
for (const marker of ['authorizeWorkbench(', 'authorizeRuntime(', 'requirePlatformAdmin(', 'requireWorkspaceMembership(', 'requireWorkspaceCapabilities(', 'recordDecision(']) {
  if (!authorization.includes(marker)) failures.push(`统一授权服务缺少 ${marker}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
for (const marker of ['authorization?.authorizeRuntime', 'authorization?.roleIds', 'authorization?.dataScopes']) {
  if (!orchestration.includes(marker)) failures.push(`Run 编排缺少授权结果注入：${marker}`)
}
if (orchestration.includes("role_ids: ['role-employee']")) failures.push('Run Manifest 仍硬编码普通员工角色')

for (const file of [
  'server/src/modules/agent/postgres-agent-service.ts',
  'server/src/modules/skill/postgres-skill-service.ts',
  'server/src/modules/tool/postgres-tool-connector-service.ts',
]) {
  const source = readFileSync(resolve(root, file), 'utf8')
  if (!source.includes("r.permissions ? 'admin:*'")) failures.push(`${file} 未校验平台管理员权限`)
  if (!source.includes('valid_until')) failures.push(`${file} 未过滤过期角色`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:authorization', 'test:m4:authorization:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M4-06 权限与数据范围基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-06 权限与数据范围基线验证通过：身份、角色、空间、能力、数据范围、Manifest 和审计链路齐全。')
