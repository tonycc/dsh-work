import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const projectRoot = new URL('../', import.meta.url)
const violations = []

async function sourceFiles(directory) {
  const entries = await readdir(new URL(directory, projectRoot), { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(`${path}/`)))
    if (entry.isFile() && ['.ts', '.vue', '.js', '.mjs'].includes(extname(entry.name))) files.push(path)
  }

  return files
}

function reject(path, content, pattern, message) {
  if (pattern.test(content)) violations.push(`${relative('.', path)}：${message}`)
}

for (const path of await sourceFiles('apps/workbench-web/src/')) {
  const content = await readFile(new URL(path, projectRoot), 'utf8')
  reject(path, content, /@dsh-work\/admin-components|apps\/admin-web|\/api\/admin\//, '员工端不得依赖管理端源码、组件或 API')
  reject(path, content, /server\/src|from ['"][^'"]*server\//, '前端不得直接依赖服务端实现')
}

for (const path of await sourceFiles('apps/admin-web/src/')) {
  const content = await readFile(new URL(path, projectRoot), 'utf8')
  reject(path, content, /@dsh-work\/workbench-components|apps\/workbench-web|\/api\/workbench\//, '管理端不得依赖员工端源码、组件或 API')
  reject(path, content, /server\/src|from ['"][^'"]*server\//, '前端不得直接依赖服务端实现')
}

for (const path of await sourceFiles('packages/')) {
  const content = await readFile(new URL(path, projectRoot), 'utf8')
  reject(path, content, /from ['"]pinia['"]|defineStore\s*\(/, '共享包不得持有 Pinia 业务状态')
  reject(path, content, /from ['"]vue-router['"]|useRoute\s*\(|useRouter\s*\(/, '共享包不得直接依赖应用 Router')
  reject(path, content, /apps\/(workbench-web|admin-web)\//, '共享包不得反向依赖应用源码')
}

if (violations.length > 0) {
  console.error(`架构边界检查失败：\n${violations.map((item) => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('架构边界检查通过：双前端、双 API 与无状态共享包边界有效。')
}
