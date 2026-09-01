import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

const requiredFiles = [
  'README.md',
  '.github/workflows/ci.yml',
  'docs/README.md',
  'docs/architecture/overview.md',
  'docs/project/mvp-roadmap.md',
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

const legacyRootDocuments = [
  'dsh-work 产品设计方案.md',
  'dsh-work 产品架构方案（简化版）.md',
  'dsh-work MVP 实施方案与计划.md',
  '前端原型评审说明.md',
]
for (const file of legacyRootDocuments) {
  if (existsSync(resolve(root, file))) failures.push(`根目录仍存在已归并的历史文档：${file}`)
}

const architecture = read('docs/architecture/overview.md')
for (const required of ['Node.js 模块化单体', '独立 DSH Worker', 'AI Hub OIDC', 'PostgreSQL 是产品运行事实来源']) {
  if (!architecture.includes(required)) failures.push(`架构总览缺少：${required}`)
}

const implementationPlan = read('docs/project/mvp-roadmap.md')
for (const required of ['M0 实施基线冻结', 'M1 Runtime 技术 POC', 'M4-01', 'M4-09', 'MVP 必测业务用例']) {
  if (!implementationPlan.includes(required)) failures.push(`MVP 路线图缺少：${required}`)
}

const githubCi = read('.github/workflows/ci.yml')
for (const required of ['actions/checkout@v6', 'pnpm/setup@v2', 'pnpm install --frozen-lockfile', 'pnpm ci:check']) {
  if (!githubCi.includes(required)) failures.push(`GitHub CI 缺少：${required}`)
}

if (failures.length) {
  console.error('M0 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M0 基线验证通过：原型、契约、数据、测试和项目治理文件齐全。')
