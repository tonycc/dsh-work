import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/deployment/ai-hub-sso-integration.md',
  'docs/project/m6-ai-hub-sso-checklist.md',
  'server/migrations/0014_m6_ai_hub_sso.sql',
  'server/migrations/0016_identity_owned_authorization.sql',
  'server/migrations/0017_business_user_directory.sql',
  'server/migrations/0018_fail_closed_directory_reconciliation.sql',
  'server/src/http/auth-routes.ts',
  'server/src/http/admin/identity-routes.ts',
  'server/src/modules/identity/config.ts',
  'server/src/modules/identity/secure-values.ts',
  'server/src/modules/identity/oidc-client.ts',
  'server/src/modules/identity/ai-hub-client.ts',
  'server/src/modules/identity/session-repository.ts',
  'server/src/modules/identity/auth-service.ts',
  'server/src/modules/identity/directory-sync-service.ts',
  'server/src/modules/identity/administration-service.ts',
  'server/src/modules/identity/identity.test.ts',
  'server/src/modules/identity/identity.integration.test.ts',
  'apps/admin-web/src/views/IdentityAccessView.vue',
  'apps/workbench-web/src/views/AuthErrorView.vue',
  'apps/admin-web/src/views/AuthErrorView.vue',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:sso', 'test:sso:integration', 'verify:m6:sso']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const workflow = read('.github/workflows/ci.yml')
if (!workflow.includes('test:sso:integration')) failures.push('GitHub Actions 缺少 test:sso:integration')

const configuration = read('server/src/modules/identity/config.ts')
for (const marker of [
  "production && mode !== 'oidc'",
  '`__Host-${name}`',
  'DSH_WORK_COOKIE_SECURE',
  "'offline_access'",
  "'platform.application.bootstrap'",
  'AI_HUB_ENVIRONMENT',
  '必须使用同一个 AI Hub 应用',
  'DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS',
]) {
  if (!configuration.includes(marker)) failures.push(`OIDC 配置边界缺少 ${marker}`)
}

const authentication = read('server/src/modules/identity/auth-service.ts')
for (const marker of [
  'equalOpaqueHash',
  'validateRequestOrigin',
  'refreshTokensWithLock',
  'claimInitialAdministrator',
  'claim.initial_admin_user_id',
  'resolveAuthorization',
  'LOCAL_PERMISSIONS.adminWrite',
]) {
  if (!authentication.includes(marker)) failures.push(`OIDC/本地鉴权边界缺少 ${marker}`)
}
if (authentication.includes('claim.owner_user_id')) failures.push('Bootstrap 仍把应用负责人当作环境初始管理员')

const bridgeClient = read('server/src/modules/identity/ai-hub-client.ts')
for (const forbidden of ['/me/permissions', '/authorization/decisions']) {
  if (bridgeClient.includes(forbidden)) failures.push(`AI Hub Client 仍包含已废弃业务授权调用 ${forbidden}`)
}

const identityTypes = read('server/src/modules/identity/types.ts')
if (identityTypes.includes('dsh_work.')) failures.push('服务端身份类型仍声明 AI Hub dsh_work.* 业务权限')

const migration = read('server/migrations/0016_identity_owned_authorization.sql')
for (const marker of [
  'external_user_id',
  'local_authorization_version',
  'application_admin_bootstrap_claims',
  'identity_directory_sync_state',
  "delete from user_roles where source_key like 'ai-hub:%'",
  'user_roles_local_source_check',
]) {
  if (!migration.includes(marker)) failures.push(`身份自主授权迁移缺少 ${marker}`)
}

const administration = read('server/src/modules/identity/administration-service.ts')
for (const marker of [
  'requireAnotherPlatformAdmin',
  'lockPlatformAdminInvariant',
  'pg_advisory_xact_lock',
  'replaceUserScopes',
  'revokeSessions',
]) {
  if (!administration.includes(marker)) failures.push(`本地授权管理缺少 ${marker}`)
}

const businessDirectoryMigration = read('server/migrations/0017_business_user_directory.sql')
if (!businessDirectoryMigration.includes('business_user boolean not null default false')) {
  failures.push('员工目录迁移必须按非业务用户默认值 fail closed')
}

const directoryReconciliation = read('server/migrations/0018_fail_closed_directory_reconciliation.sql')
for (const marker of ['business_user = false', 'cursor = null']) {
  if (!directoryReconciliation.includes(marker)) failures.push(`目录升级对账迁移缺少 ${marker}`)
}

const guide = read('docs/deployment/ai-hub-sso-integration.md')
for (const marker of [
  'http://localhost:4190/auth/workbench/callback',
  'http://localhost:4190/auth/admin/callback',
  'platform.application.bootstrap',
  'platform.directory.read',
  'OIDC_ONLY',
  '不要再创建 `dsh-work-admin`',
  '平台登记人、应用负责人和环境初始管理员相互独立',
  '至少再配置一位平台管理员',
]) {
  if (!guide.includes(marker)) failures.push(`AI Hub 身份对接文档缺少 ${marker}`)
}

const checklist = read('docs/project/m6-ai-hub-sso-checklist.md')
for (const marker of ['待平台管理员执行', '待运维执行', '待联调']) {
  if (!checklist.includes(marker)) failures.push(`M6 身份清单缺少外部边界 ${marker}`)
}

if (failures.length > 0) {
  console.error('M6 AI Hub 身份与应用自主授权 Gate 验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M6 AI Hub 身份与应用自主授权 Gate 验证通过：OIDC、一次性管理员、员工目录、本地 RBAC、Session、管理界面、迁移、文档和测试证据齐全；真实平台配置与 UAT 保持开放。')

function read(file) {
  return readFileSync(resolve(root, file), 'utf8')
}
