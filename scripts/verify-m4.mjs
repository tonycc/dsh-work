import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const checklists = [
  'm4-agent-management-checklist.md',
  'm4-skill-management-checklist.md',
  'm4-tool-connector-management-checklist.md',
  'm4-enterprise-knowledge-checklist.md',
  'm4-file-analysis-checklist.md',
  'm4-permission-data-scope-checklist.md',
  'm4-runtime-operations-checklist.md',
  'm4-audit-operations-checklist.md',
  'm4-notification-error-experience-checklist.md',
  'm4-exit-checklist.md',
]
for (const file of checklists) {
  if (!existsSync(resolve(root, 'docs/project', file))) failures.push(`docs/project/${file} 文件不存在`)
}

const plan = readFileSync(resolve(root, 'docs/project/mvp-roadmap.md'), 'utf8')
for (let index = 1; index <= 9; index += 1) {
  const id = `M4-${String(index).padStart(2, '0')}`
  if (!plan.includes(`${id} `)) failures.push(`实施方案缺少 ${id} 完成说明`)
}
for (const boundary of ['D-03', 'D-05', 'D-06', 'R-15']) {
  if (!plan.includes(boundary)) failures.push(`M4 Gate 说明缺少外部边界 ${boundary}`)
}
if (!/不等于真实业务(?: UAT|试点准入通过)/.test(plan)) {
  failures.push('M4 Gate 说明缺少真实业务 UAT/试点准入边界')
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of [
  'verify:m4:agent', 'verify:m4:skill', 'verify:m4:tool', 'verify:m4:knowledge',
  'verify:m4:file', 'verify:m4:authorization', 'verify:m4:runtime', 'verify:m4:audit',
  'verify:m4:error', 'verify:m4',
]) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M4 总 Gate 基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4 工程 Gate 基线验证通过：M4-01～M4-09 证据齐全，外部试点准入项仍保持开放且未被工程验证替代。')
