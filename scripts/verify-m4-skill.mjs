import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-skill-management-checklist.md',
  'server/migrations/0006_m4_skill_management.sql',
  'server/src/modules/skill/postgres-skill-service.ts',
  'server/src/http/admin/skill-routes.ts',
  'server/src/infrastructure/postgres/m4-skill-management.integration.test.ts',
  'apps/admin-web/src/components/SkillEditorDialog.vue',
  'apps/admin-web/src/views/CapabilityManagementView.vue',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0006_m4_skill_management.sql'), 'utf8')
for (const table of ['skill_test_runs', 'skill_release_records']) {
  if (!migration.includes(`create table ${table}`)) failures.push(`M4-02 迁移缺少 ${table}`)
}
for (const column of ['active_version_id', 'draft_version_id', 'configuration_fingerprint']) {
  if (!migration.includes(column)) failures.push(`M4-02 迁移缺少 ${column}`)
}

const service = readFileSync(resolve(root, 'server/src/modules/skill/postgres-skill-service.ts'), 'utf8')
for (const method of ['createSkill(', 'updateSkill(', 'testSkill(', 'setStatus(', 'rollback(', 'assertPublishedReferences(', 'resolveRuntimeSkills(']) {
  if (!service.includes(method)) failures.push(`Skill Service 缺少 ${method}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
if (!orchestration.includes('skill_instructions')) failures.push('Run Manifest 尚未固化 Skill 指令')
const runtime = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
if (!runtime.includes('# 已启用 Skill')) failures.push('DSH Runtime 尚未组合 Skill 指令')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:skill', 'test:m4:skill:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const contract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/skills', '/skills/test', '/skills/status', '/skills/rollback', '/skill-versions', '/skill-release-records']) {
  if (!contract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

if (failures.length > 0) {
  console.error('M4-02 Skill 管理基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-02 Skill 管理基线验证通过：自动标识、测试门禁、版本、Agent 引用和 DSH 指令注入齐全。')
