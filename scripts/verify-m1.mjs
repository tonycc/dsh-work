import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/poc/m1-runtime-poc.md',
  'docs/project/m1-exit-checklist.md',
  'server/src/modules/runtime/acp-json-rpc-client.ts',
  'server/src/modules/runtime/dsh-acp-runtime-adapter.ts',
  'server/src/modules/runtime/dsh-acp-process-configuration.ts',
  'server/src/modules/runtime/dsh-runtime-installation.ts',
  'server/config/dsh/acp-managed-credentials.cordis.yml',
  'server/config/dsh/acp-managed-credentials.legacy.cordis.yml',
  'server/config/dsh/runtime-lock.json',
  'server/migrations/0019_dsh_runtime_0_1_2_rc_1.sql',
  'docs/deployment/dsh-runtime-delivery.md',
  'server/src/modules/runtime/manifest-compiler.ts',
  'server/src/modules/runtime/runtime-adapter.test.ts',
  'scripts/probe-dsh-acp.ts',
  'scripts/probe-dsh-acp-real.ts',
  'scripts/probe-dsh-acp-cancel.ts',
  'scripts/probe-dsh-acp-concurrency.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:m1', 'probe:m1', 'probe:m1:real', 'probe:m1:tool', 'probe:m1:artifact', 'probe:m1:cancel', 'probe:m1:concurrency']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const poc = readFileSync(resolve(root, 'docs/poc/m1-runtime-poc.md'), 'utf8')
for (const fragment of ['ACP JSON-RPC stdio', 'realModelPromptExecuted', '最终决定不 Fork DSH', '受管 Runtime 制品', 'M1 工作项结论']) {
  if (!poc.includes(fragment)) failures.push(`M1 POC 记录缺少：${fragment}`)
}

const runtimeLock = JSON.parse(readFileSync(resolve(root, 'server/config/dsh/runtime-lock.json'), 'utf8'))
const processConfiguration = readFileSync(
  resolve(root, 'server/src/modules/runtime/dsh-acp-process-configuration.ts'),
  'utf8',
)
for (const fragment of [
  'tsx/esm', 'apps/cli/src/bin.ts', "'--profile'", "'acp'", "'--patch'",
  'packages/examples/acp-demo/src/bin.ts', "'--config'",
]) {
  if (!processConfiguration.includes(fragment)) failures.push(`DSH ACP 正式 profile 入口缺少：${fragment}`)
}

const localCompatibilityMode = 'legacy-0.1.1-rc.2'
const localCompatibility = runtimeLock.compatibility?.[localCompatibilityMode]
if (localCompatibility?.version !== '0.1.1-rc.2'
  || localCompatibility?.commit !== 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
  || localCompatibility?.adapter !== 'legacy-acp-demo'
  || localCompatibility?.scope !== 'development') {
  failures.push('DSH 本地兼容 Runtime Lock 不完整或不精确')
}

const preflight = readFileSync(resolve(root, 'scripts/deploy/preflight.sh'), 'utf8')
for (const fragment of ['apps/cli/src/bin.ts', 'apps/cli/lib/bin.js', 'packages/bundle/acp-app/cordis.patch.yml']) {
  if (!preflight.includes(fragment)) failures.push(`DSH 部署预检缺少：${fragment}`)
}

const localEnvironment = readFileSync(resolve(root, '.env.example'), 'utf8')
for (const fragment of [
  `DSH_RUNTIME_COMPATIBILITY=${localCompatibilityMode}`,
  `DSH_EXPECTED_VERSION=${localCompatibility?.version ?? ''}`,
  `DSH_EXPECTED_COMMIT=${localCompatibility?.commit ?? ''}`,
]) {
  if (!localEnvironment.includes(fragment)) failures.push(`.env.example 的本地 DSH 兼容配置缺少：${fragment}`)
}

const deploymentEnvironment = readFileSync(resolve(root, 'deploy/runtime.env.example'), 'utf8')
for (const fragment of [
  `DSH_EXPECTED_VERSION=${runtimeLock.version}`,
  `DSH_EXPECTED_COMMIT=${runtimeLock.commit}`,
]) {
  if (!deploymentEnvironment.includes(fragment)) failures.push(`deploy/runtime.env.example 缺少：${fragment}`)
}
if (!preflight.includes('DSH_RUNTIME_COMPATIBILITY is development-only')) {
  failures.push('生产部署预检没有拒绝本地 DSH 兼容模式')
}

if (failures.length > 0) {
  console.error('M1 POC 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M1 POC 基线验证通过：Adapter、测试、真实 DSH 探针和退出清单齐全。')
