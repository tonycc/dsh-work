import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m5-security-testing-checklist.md',
  'scripts/check-secrets.mjs',
  'server/src/security/safe-observability.ts',
  'server/src/security/safe-observability.test.ts',
  'server/src/infrastructure/postgres/m5-security-regression.integration.test.ts',
  'server/config/dsh/dsh-work-tool-policy.js',
  'server/config/dsh/dsh-work-tool-policy.test.js',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:m5:security', 'test:m5:security:integration', 'check:secrets', 'verify:m5:security']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
for (const marker of ['pnpm ci:check', 'test:m5:security:integration']) {
  if (!workflow.includes(marker)) failures.push(`GitHub Actions 缺少 ${marker}`)
}

const integrationTest = readFileSync(resolve(root, 'server/src/infrastructure/postgres/m5-security-regression.integration.test.ts'), 'utf8')
for (const marker of ['cross-user and cross-workspace', 'traversal paths', 'authorization denies', 'redacted before persistence']) {
  if (!integrationTest.includes(marker)) failures.push(`安全集成测试缺少 ${marker} 场景`)
}

const client = readFileSync(resolve(root, 'server/src/modules/runtime/acp-json-rpc-client.ts'), 'utf8')
for (const marker of ['buildAcpChildEnvironment', 'isSensitiveEnvironmentKey', 'redactSensitiveText']) {
  if (!client.includes(marker)) failures.push(`ACP 子进程安全边界缺少 ${marker}`)
}
if (/spawn\([\s\S]{0,400}env:\s*process\.env/.test(client)) {
  failures.push('ACP 子进程仍直接继承 process.env')
}

const observability = readFileSync(resolve(root, 'server/src/security/safe-observability.ts'), 'utf8')
for (const marker of ['sanitizeSafeMetadata', 'redactSensitiveText', "'[REDACTED]'"]) {
  if (!observability.includes(marker)) failures.push(`安全可观测性缺少 ${marker}`)
}

const checklist = readFileSync(resolve(root, 'docs/project/m5-security-testing-checklist.md'), 'utf8')
for (const marker of ['企业 SSO', '企业级恶意文件扫描', 'M5-06', '工程 Gate']) {
  if (!checklist.includes(marker)) failures.push(`M5-02 清单缺少边界：${marker}`)
}

if (failures.length > 0) {
  console.error('M5-02 权限与安全测试验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M5-02 权限与安全测试验证通过：授权隔离、文件边界、审计脱敏、Secret 扫描、DSH 子进程环境白名单和 Tool Allowlist 均有自动化证据。')
