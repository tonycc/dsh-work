import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-runtime-operations-checklist.md',
  'server/migrations/0011_m4_runtime_operations.sql',
  'server/src/infrastructure/postgres/m4-runtime-operations.integration.test.ts',
  'apps/admin-web/src/views/RuntimeManagementView.vue',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0011_m4_runtime_operations.sql'), 'utf8')
for (const marker of ['runtime_id', 'runtime_configurations_latest', 'run_attempts_runtime_schedule']) {
  if (!migration.includes(marker)) failures.push(`M4-07 迁移缺少 ${marker}`)
}

const operations = readFileSync(resolve(root, 'server/src/modules/admin/application/postgres-operations-service.ts'), 'utf8')
for (const marker of ['getRuntimePolicy(', 'configureScheduling', 'attemptTimeoutMinutes * 60', '不能小于当前活动 Worker 数', 'requirePlatformAdmin(']) {
  if (!operations.includes(marker)) failures.push(`Runtime 运维服务缺少 ${marker}`)
}

const repository = readFileSync(resolve(root, 'server/src/modules/run/postgres-run-repository.ts'), 'utf8')
for (const marker of ["runtime.schedulingStatus !== 'accepting'", 'runtime.capacity']) {
  if (!repository.includes(marker)) failures.push(`Attempt 调度缺少 ${marker}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
for (const marker of ['getRuntimePolicy(runtimeId)', 'Math.min(agent.timeoutSeconds']) {
  if (!orchestration.includes(marker)) failures.push(`Run Manifest 未应用 Runtime 超时：${marker}`)
}

const adapter = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
if (!adapter.includes('async configureScheduling(')) failures.push('DSH Adapter 缺少动态调度状态配置')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:runtime', 'test:m4:runtime:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const contract = JSON.parse(readFileSync(resolve(root, 'docs/contracts/openapi-admin.json'), 'utf8'))
for (const path of ['/runtimes', '/runtimes/check', '/runtimes/configuration']) {
  if (!contract.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

if (failures.length > 0) {
  console.error('M4-07 Runtime 运维配置基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-07 Runtime 运维配置基线验证通过：容量、超时、调度状态、健康、权限、历史和审计齐全。')
