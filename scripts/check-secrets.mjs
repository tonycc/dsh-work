import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean)

const signatures = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['model API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/],
]
const failures = []

for (const file of files) {
  const path = resolve(root, file)
  if (statSync(path).size > 2 * 1024 * 1024) continue
  const content = readFileSync(path)
  if (content.includes(0)) continue
  const text = content.toString('utf8')
  for (const [label, pattern] of signatures) {
    if (pattern.test(text)) failures.push(`${file} 疑似包含 ${label}`)
  }
}

if (failures.length > 0) {
  console.error('敏感凭据扫描失败：')
  failures.forEach(failure => console.error(`- ${failure}`))
  process.exit(1)
}

console.log(`敏感凭据扫描通过：已检查 ${files.length} 个版本控制候选文件，未发现已知密钥签名。`)
