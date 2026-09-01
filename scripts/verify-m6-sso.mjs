import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/deployment/ai-hub-sso-integration.md',
  'docs/project/m6-ai-hub-sso-checklist.md',
  'server/migrations/0014_m6_ai_hub_sso.sql',
  'server/migrations/0015_m6_identity_grant_sources.sql',
  'server/src/http/auth-routes.ts',
  'server/src/modules/identity/config.ts',
  'server/src/modules/identity/secure-values.ts',
  'server/src/modules/identity/oidc-client.ts',
  'server/src/modules/identity/ai-hub-client.ts',
  'server/src/modules/identity/session-repository.ts',
  'server/src/modules/identity/auth-service.ts',
  'server/src/modules/identity/identity.test.ts',
  'server/src/modules/identity/identity.integration.test.ts',
  'apps/workbench-web/src/views/AuthErrorView.vue',
  'apps/workbench-web/src/views/AccessDeniedView.vue',
  'apps/admin-web/src/views/AuthErrorView.vue',
  'apps/admin-web/src/views/AccessDeniedView.vue',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:sso', 'test:sso:integration', 'verify:m6:sso']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
if (!workflow.includes('test:sso:integration')) failures.push('GitHub Actions 缺少 test:sso:integration')

const configuration = readFileSync(resolve(root, 'server/src/modules/identity/config.ts'), 'utf8')
for (const marker of [
  "production && mode !== 'oidc'",
  '`__Host-${name}`',
  'DSH_WORK_COOKIE_SECURE',
  "'offline_access'",
  'production && !adminOnlineAuthorization',
]) {
  if (!configuration.includes(marker)) failures.push(`OIDC 生产配置缺少 ${marker}`)
}

const authentication = readFileSync(resolve(root, 'server/src/modules/identity/auth-service.ts'), 'utf8')
for (const marker of ['equalOpaqueHash', 'validateRequestOrigin', 'refreshTokensWithLock', 'AI_HUB_PERMISSIONS.adminWrite']) {
  if (!authentication.includes(marker)) failures.push(`OIDC 鉴权边界缺少 ${marker}`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0014_m6_ai_hub_sso.sql'), 'utf8')
for (const marker of ['oidc_login_transactions', 'authentication_sessions', 'uploaded_by']) {
  if (!migration.includes(marker)) failures.push(`M6 身份迁移缺少 ${marker}`)
}
const grantMigration = readFileSync(resolve(root, 'server/migrations/0015_m6_identity_grant_sources.sql'), 'utf8')
for (const marker of ['source_key', 'user_roles_by_source']) {
  if (!grantMigration.includes(marker)) failures.push(`M6 授权来源迁移缺少 ${marker}`)
}

const guide = readFileSync(resolve(root, 'docs/deployment/ai-hub-sso-integration.md'), 'utf8')
for (const marker of [
  'http://localhost:4190/auth/workbench/callback',
  'http://localhost:4190/auth/admin/callback',
  'dsh_work.admin.write',
  'platform.application.read',
  'platform.notification.request',
  'offline_access',
  'IN_APP',
  'API_ONLY',
]) {
  if (!guide.includes(marker)) failures.push(`AI Hub 对接文档缺少 ${marker}`)
}

const checklist = readFileSync(resolve(root, 'docs/project/m6-ai-hub-sso-checklist.md'), 'utf8')
for (const marker of ['待平台管理员执行', '待运维执行', '待联调']) {
  if (!checklist.includes(marker)) failures.push(`M6 SSO 清单缺少外部边界 ${marker}`)
}

if (failures.length > 0) {
  console.error('M6 AI Hub SSO 工程 Gate 验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M6 AI Hub SSO 工程 Gate 验证通过：OIDC、服务端 Session、权限、迁移、前端、文档和数据库集成测试证据齐全；平台配置与真实 UAT 保持开放。')
