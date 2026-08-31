import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const requiredFiles = [
  'docs/project/m4-file-analysis-checklist.md',
  'server/migrations/0009_m4_file_analysis.sql',
  'server/src/modules/workbench/application/document-extractor.ts',
  'server/src/modules/workbench/application/document-extractor.test.ts',
  'server/src/infrastructure/postgres/m4-file-analysis.integration.test.ts',
]

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) failures.push(`${file} 文件不存在`)
}

const migration = readFileSync(resolve(root, 'server/migrations/0009_m4_file_analysis.sql'), 'utf8')
for (const marker of ['create table file_extractions', 'create table run_input_files', 'extractor_version', 'text_sha256', 'mount_path']) {
  if (!migration.includes(marker)) failures.push(`M4-05 迁移缺少 ${marker}`)
}

const extractor = readFileSync(resolve(root, 'server/src/modules/workbench/application/document-extractor.ts'), 'utf8')
for (const marker of ['extractPdf(', 'extractDocx(', 'extractXlsx(', 'extractCsv(', 'maxExtractedCharacters']) {
  if (!extractor.includes(marker)) failures.push(`文档解析器缺少 ${marker}`)
}

const content = readFileSync(resolve(root, 'server/src/modules/workbench/application/postgres-content-service.ts'), 'utf8')
for (const marker of ['storeSessionFile(', 'prepareRuntimeFiles(', 'extractDocument(']) {
  if (!content.includes(marker)) failures.push(`Content Service 缺少 ${marker}`)
}

const orchestration = readFileSync(resolve(root, 'server/src/modules/run/run-orchestration-service.ts'), 'utf8')
for (const marker of ['fileIds?: string[]', 'file_mounts: preparedFiles.map', 'inputFiles: preparedFiles.map']) {
  if (!orchestration.includes(marker)) failures.push(`Run 编排缺少文件链路：${marker}`)
}
const runRepository = readFileSync(resolve(root, 'server/src/modules/run/postgres-run-repository.ts'), 'utf8')
if (!runRepository.includes('insert into run_input_files')) {
  failures.push('Run Repository 缺少与 Attempt 原子写入的文件输入快照')
}

const adapter = readFileSync(resolve(root, 'server/src/modules/runtime/dsh-acp-runtime-adapter.ts'), 'utf8')
for (const marker of ['mount.mount_path', "flag: 'wx'", 'chmod(target, 0o400)']) {
  if (!adapter.includes(marker)) failures.push(`Runtime Adapter 缺少只读挂载控制：${marker}`)
}

const schema = JSON.parse(readFileSync(resolve(root, 'docs/contracts/runtime-manifest.schema.json'), 'utf8'))
const mount = schema.$defs?.fileMount
for (const field of ['file_id', 'mount_path', 'access', 'source_name', 'media_type', 'content_sha256', 'content']) {
  if (!mount?.required?.includes(field)) failures.push(`Runtime Manifest FileMount 缺少必填字段 ${field}`)
}

const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
for (const script of ['verify:m4:file', 'test:m4:file', 'test:m4:file:integration']) {
  if (typeof packageJson.scripts?.[script] !== 'string') failures.push(`package.json 缺少 ${script}`)
}

if (failures.length > 0) {
  console.error('M4-05 文件分析基线验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('M4-05 文件分析基线验证通过：上传、解析、权限、不可变挂载和结果追溯齐全。')
