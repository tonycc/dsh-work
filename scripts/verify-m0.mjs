import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

const requiredFiles = [
  'dsh-work MVP 实施方案与计划.md',
  '前端原型评审说明.md',
  'docs/baselines/m0-prototype-baseline.md',
  'docs/contracts/openapi-workbench.json',
  'docs/contracts/openapi-admin.json',
  'docs/contracts/internal-ports.md',
  'docs/contracts/runtime-manifest.schema.json',
  'docs/contracts/run-event.schema.json',
  'docs/data-model.md',
  'docs/testing/mvp-test-data.md',
  'docs/testing/fixtures/mvp-fixtures.json',
  'docs/project/decision-register.md',
  'docs/project/risk-register.md',
  'docs/project/ci-integration.md',
  'docs/project/m0-exit-checklist.md',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    return ''
  }
}

function parseJson(path) {
  try {
    return JSON.parse(read(path))
  } catch (error) {
    failures.push(`${path} 不是有效 JSON：${error instanceof Error ? error.message : '未知错误'}`)
    return null
  }
}

const workbenchApi = parseJson('docs/contracts/openapi-workbench.json')
const adminApi = parseJson('docs/contracts/openapi-admin.json')
const runtimeManifest = parseJson('docs/contracts/runtime-manifest.schema.json')
const runEvent = parseJson('docs/contracts/run-event.schema.json')
const fixtures = parseJson('docs/testing/fixtures/mvp-fixtures.json')

for (const [name, document] of [
  ['员工 API', workbenchApi],
  ['管理 API', adminApi],
]) {
  if (document && document.openapi !== '3.1.0') failures.push(`${name} 必须使用 OpenAPI 3.1.0`)
}

const requiredWorkbenchPaths = [
  '/session',
  '/workspaces',
  '/sessions',
  '/sessions/{sessionId}/runs',
  '/runs/{runId}/events',
  '/runs/{runId}/cancel',
  '/artifacts/{artifactId}/versions/{versionId}/download',
]
for (const path of requiredWorkbenchPaths) {
  if (workbenchApi && !workbenchApi.paths?.[path]) failures.push(`员工 API 缺少路径：${path}`)
}

const requiredAdminPaths = [
  '/agents',
  '/skills',
  '/tools',
  '/connectors',
  '/runtimes',
  '/runtimes/configuration',
  '/sessions',
  '/workspaces',
  '/audit-events',
  '/health',
]
for (const path of requiredAdminPaths) {
  if (adminApi && !adminApi.paths?.[path]) failures.push(`管理 API 缺少路径：${path}`)
}

if (runtimeManifest && runtimeManifest.$id !== 'https://dsh-work.local/schemas/runtime-manifest.schema.json') {
  failures.push('Runtime Manifest Schema 缺少稳定 $id')
}
if (runEvent && runEvent.$id !== 'https://dsh-work.local/schemas/run-event.schema.json') {
  failures.push('Run Event Schema 缺少稳定 $id')
}

for (const collection of ['users', 'roles', 'workspaces', 'businessRecords', 'knowledgeDocuments', 'files']) {
  if (fixtures && !Array.isArray(fixtures[collection])) failures.push(`测试数据缺少数组：${collection}`)
}

const productPlan = read('dsh-work 产品设计方案.md')
for (const forbidden of ['每名员工默认拥有个人 Workspace', '个人 Workspace、文件和 Session', '历史任务。']) {
  if (productPlan.includes(forbidden)) failures.push(`产品方案仍包含已废弃范围：${forbidden}`)
}

const implementationPlan = read('dsh-work MVP 实施方案与计划.md')
for (const required of ['M0 实施基线冻结', 'M1 Runtime 技术 POC', 'D-01', 'Mock 替换顺序', 'MVP 必测业务用例']) {
  if (!implementationPlan.includes(required)) failures.push(`实施计划缺少：${required}`)
}

if (failures.length) {
  console.error('M0 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M0 基线验证通过：原型、契约、数据、测试和项目治理文件齐全。')
