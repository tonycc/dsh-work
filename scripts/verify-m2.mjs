import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m2-exit-checklist.md',
  'server/migrations/0001_m2_platform.sql',
  'server/migrations/0002_m2_seed.sql',
  'server/src/infrastructure/postgres/database.ts',
  'server/src/infrastructure/postgres/migration-runner.ts',
  'server/src/infrastructure/postgres/postgres-repositories.integration.test.ts',
  'server/src/modules/run/postgres-run-repository.ts',
  'server/src/modules/run/run-state-machine.ts',
  'server/src/modules/model/postgres-model-governance-repository.ts',
  'apps/admin-web/src/views/ModelGovernanceView.vue',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0001_m2_platform.sql'), 'utf8')
for (const table of ['runs', 'run_attempts', 'run_events', 'model_providers', 'provider_models', 'model_routes', 'credential_refs']) {
  if (!migration.includes(`create table ${table}`)) failures.push(`M2 迁移缺少 ${table}`)
}
for (const forbidden of ['api_key text', 'secret_value', 'credential_value']) {
  if (migration.toLowerCase().includes(forbidden)) failures.push(`M2 迁移不应包含密钥正文列：${forbidden}`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m2', 'test:m2', 'test:m2:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const contract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/model-providers', '/provider-models', '/model-routes']) {
  if (!contract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

if (failures.length > 0) {
  console.error('M2 工程基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M2 工程基线验证通过：迁移、Run Repository、模型治理、密钥引用和退出清单齐全。')
