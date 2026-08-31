import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m5-automated-test-baseline-checklist.md',
  'apps/workbench-web/vitest.config.ts',
  'apps/admin-web/vitest.config.ts',
  'apps/workbench-web/src/components/TaskComposer.test.ts',
  'apps/workbench-web/src/stores/tasks.test.ts',
  'apps/workbench-web/src/api/client.test.ts',
  'apps/admin-web/src/stores/auth.test.ts',
  'apps/admin-web/src/api/client.test.ts',
  'server/src/http/api-contract.test.ts',
  'playwright.config.ts',
  'e2e/mvp-smoke.spec.ts',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const dependency of ['vitest', '@vue/test-utils', 'happy-dom', '@playwright/test']) {
  if (typeof packageJson.devDependencies?.[dependency] !== 'string') failures.push(`根 devDependencies 缺少 ${dependency}`)
}
for (const script of ['test:m5:frontend', 'test:m5:api', 'test:e2e', 'verify:m5:test']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
for (const marker of ['pnpm ci:check', 'playwright install --with-deps chromium', 'pnpm test:e2e', 'test:m4:error:integration']) {
  if (!workflow.includes(marker)) failures.push(`GitHub Actions 缺少 ${marker}`)
}

const e2e = readFileSync(resolve(root, 'e2e/mvp-smoke.spec.ts'), 'utf8')
for (const marker of ['employee can open', '供应链经营分析', 'administrator can navigate', '连接器状态', 'Runtimes']) {
  if (!e2e.includes(marker)) failures.push(`E2E 冒烟缺少 ${marker} 场景`)
}

const apiTest = readFileSync(resolve(root, 'server/src/http/api-contract.test.ts'), 'utf8')
for (const marker of ['workbench', 'admin', 'route_not_found', 'invalid_request', 'Agent DTO']) {
  if (!apiTest.includes(marker)) failures.push(`API 契约测试缺少 ${marker}`)
}

if (failures.length > 0) {
  console.error('M5-01 自动化测试基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M5-01 自动化测试基线验证通过：前端组件/Store/API、后端领域/Repository/API、Runtime 与浏览器 E2E 均已进入 CI。')
