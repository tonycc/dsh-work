import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-enterprise-knowledge-checklist.md',
  'server/migrations/0008_m4_enterprise_knowledge.sql',
  'server/src/modules/knowledge/postgres-knowledge-service.ts',
  'server/src/infrastructure/postgres/m4-enterprise-knowledge.integration.test.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0008_m4_enterprise_knowledge.sql'), 'utf8')
for (const table of ['knowledge_sources', 'knowledge_documents', 'run_knowledge_sources']) {
  if (!migration.includes(`create table ${table}`)) failures.push(`M4-04 迁移缺少 ${table}`)
}
for (const marker of ['allowed_role_ids', 'allowed_workspace_ids', 'knowledge_documents_immutable', 'synthetic']) {
  if (!migration.includes(marker)) failures.push(`M4-04 迁移缺少 ${marker}`)
}

const service = readFileSync(resolve(root, 'server/src/modules/knowledge/postgres-knowledge-service.ts'), 'utf8')
for (const method of ['resolveContext(', 'dataScopes: string[]', 'addCitationFooter(']) {
  if (!service.includes(method)) failures.push(`Knowledge Service 缺少 ${method}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
for (const marker of ['knowledge_context', 'resolveContext(', 'knowledgeSources: knowledgeContext.map', 'addCitationFooter(']) {
  if (!orchestration.includes(marker)) failures.push(`Run 编排缺少知识链路：${marker}`)
}
const runRepository = readFileSync(resolve(root, 'server/src/modules/run/postgres-run-repository.ts'), 'utf8')
if (!runRepository.includes('insert into run_knowledge_sources')) {
  failures.push('Run Repository 缺少与 Attempt 原子写入的知识来源快照')
}
const runtime = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
for (const marker of ['# 企业知识上下文', '只能依据以下已授权知识片段', '【${index + 1}】']) {
  if (!runtime.includes(marker)) failures.push(`DSH Runtime 知识提示缺少 ${marker}`)
}
const schema = JSON.parse(readFileSync(resolve(root, 'docs/contracts/runtime-manifest.schema.json'), 'utf8'))
if (!schema.properties?.knowledge_context) failures.push('Runtime Manifest Schema 缺少 knowledge_context')

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:knowledge', 'test:m4:knowledge:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M4-04 企业知识查询基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-04 企业知识查询基线验证通过：版本、权限过滤、Manifest 上下文和来源引用齐全。')
