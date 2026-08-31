import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    failures.push(`${path} 文件不存在`)
    return ''
  }
}

function forbidFragments(path, fragments) {
  const content = read(path)
  for (const fragment of fragments) {
    if (content.includes(fragment)) failures.push(`${path} 不应包含：${fragment}`)
  }
}

function requireFragments(path, fragments) {
  const content = read(path)
  for (const fragment of fragments) {
    if (!content.includes(fragment)) failures.push(`${path} 缺少：${fragment}`)
  }
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    if (entry.isFile() && ['.vue', '.css'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

const typographyTokens = read('../../packages/design-tokens/src/tokens.css')
for (const token of [
  '--dsh-font-size-micro',
  '--dsh-font-size-badge',
  '--dsh-font-size-caption',
  '--dsh-font-size-body',
  '--dsh-font-size-title',
  '--dsh-font-size-section',
  '--dsh-font-size-header',
  '--dsh-font-size-heading',
  '--dsh-font-size-page-title',
  '--dsh-font-size-metric',
  '--dsh-font-size-hero',
]) {
  if (!typographyTokens.includes(token)) failures.push(`共享字体 Token 缺少：${token}`)
}

const roots = [
  resolve(root, 'src'),
  resolve(root, '../../packages/workbench-components/src'),
  resolve(root, '../../packages/ui-core/src/components'),
]

for (const path of roots.flatMap(sourceFiles)) {
  const content = readFileSync(path, 'utf8')
  if (/font-size:\s*\d/i.test(content)) {
    failures.push(`${path} 存在未使用共享 Token 的字号`)
  }
}

const adminStyles = read('../admin-web/src/styles.css')
for (const alias of [
  '--font-size-body: var(--dsh-font-size-body)',
  '--font-size-caption: var(--dsh-font-size-caption)',
  '--font-size-badge: var(--dsh-font-size-badge)',
  '--font-size-header: var(--dsh-font-size-header)',
]) {
  if (!adminStyles.includes(alias)) failures.push(`管理端未对齐共享字体等级：${alias}`)
}

forbidFragments('src/layouts/EmployeeShell.vue', [
  'prototype-tag',
  '最小可行产品演示环境',
  '真实运行链路',
  'environment-status',
])
forbidFragments('src/views/SettingsView.vue', ['数据使用说明'])
forbidFragments('src/components/ConversationStarter.vue', ['PostgreSQL 与 DSH Runtime 已连接'])
forbidFragments('src/views/ArtifactsView.vue', ['PostgreSQL 索引'])
forbidFragments('index.html', ['交互原型'])
requireFragments('src/layouts/EmployeeShell.vue', [
  'recent-conversation__menu',
  'command="delete"',
  'ElMessageBox.confirm',
  'taskStore.deleteConversation',
])

if (failures.length) {
  console.error('员工工作台 UI 契约验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('员工工作台 UI 契约验证通过。')
