import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m5-capacity-test-report.md',
  'server/src/infrastructure/postgres/m5-capacity.integration.test.ts',
]
for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['test:m5:capacity:integration', 'verify:m5:capacity']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

const capacityTest = readFileSync(resolve(root, 'server/src/infrastructure/postgres/m5-capacity.integration.test.ts'), 'utf8')
for (const marker of [
  'for (const concurrency of [1, 3, 5])',
  "scenario: 'queue-50'",
  'expectedQueued: 45',
  'acceptanceP95Ms',
  'cpuPercent',
  'rssPeakMiB',
  'diskBytes',
  'failureRate',
]) {
  if (!capacityTest.includes(marker)) failures.push(`容量测试缺少 ${marker}`)
}

const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
if (!workflow.includes('test:m5:capacity:integration')) failures.push('GitHub Actions 缺少 M5-04 容量测试')

const report = readFileSync(resolve(root, 'docs/project/m5-capacity-test-report.md'), 'utf8')
for (const marker of ['74.66', '107.72', '829 MiB', 'D-08', 'R-15', '工程 Gate']) {
  if (!report.includes(marker)) failures.push(`M5-04 报告缺少证据或边界：${marker}`)
}

if (failures.length > 0) {
  console.error('M5-04 容量测试验证失败：')
  failures.forEach(failure => console.error(`- ${failure}`))
  process.exit(1)
}

console.log('M5-04 容量测试验证通过：1/3/5 并发、50 Run 排队、延迟、CPU、RSS、磁盘和失败率证据齐全。')
