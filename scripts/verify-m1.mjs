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
  'server/config/dsh/acp-managed-credentials.cordis.yml',
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
for (const fragment of ['ACP JSON-RPC stdio', 'realModelPromptExecuted', '最终决定不 Fork DSH', 'M1 工作项结论']) {
  if (!poc.includes(fragment)) failures.push(`M1 POC 记录缺少：${fragment}`)
}

if (failures.length > 0) {
  console.error('M1 POC 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M1 POC 基线验证通过：Adapter、测试、真实 DSH 探针和退出清单齐全。')
