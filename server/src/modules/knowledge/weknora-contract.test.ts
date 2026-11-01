import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'

import { WeKnoraClient } from './weknora-client.ts'

/**
 * 真实 WeKnora 接口契约（weknora-knowledge-plan 4.1、第 12 节 P2）：确认 4.3～4.6 依赖的接口和字段在
 * 部署的版本中存在。只在配置了以下变量时运行，CI 中跳过；升级 WeKnora 前必须跑一遍。
 *
 *   WEKNORA_CONTRACT_URL、WEKNORA_CONTRACT_API_KEY、WEKNORA_CONTRACT_EMBEDDING_MODEL_ID
 */
const baseUrl = process.env.WEKNORA_CONTRACT_URL
const apiKey = process.env.WEKNORA_CONTRACT_API_KEY
const embeddingModelId = process.env.WEKNORA_CONTRACT_EMBEDDING_MODEL_ID
const configured = Boolean(baseUrl && apiKey && embeddingModelId)

test('WeKnora 新建知识库、检索、文档元数据与删除接口符合平台依赖的契约', { skip: !configured && '未配置 WEKNORA_CONTRACT_*' }, async () => {
  const client = new WeKnoraClient({ baseUrl: baseUrl!, apiKey: apiKey!, timeoutMs: 15000 })
  const created = await client.createKnowledgeBase({
    name: `dsh-work 契约测试 ${randomUUID().slice(0, 8)}`,
    description: '由 dsh-work 契约测试创建，测试结束即删除',
    embeddingModelId: embeddingModelId!,
  })
  try {
    assert.match(created.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/, '知识库 ID 可以放进平台 ID 格式')
    // 新知识库没有文档：检索与元数据接口仍须返回 data 列表（客户端会校验结构）。
    assert.deepEqual(await client.search({ query: '契约测试', knowledgeBaseIds: [created.id], matchCount: 10 }), [])
    assert.deepEqual(await client.knowledgeBatch([`missing-${randomUUID()}`]), [])

    // WK-S2 员工端文档管理依赖的接口：上传、列表、元数据、改标题、预览、下载、重新解析、删除。
    const uploaded = await client.uploadDocument(created.id, {
      fileName: 'dsh-work-contract.txt', mimeType: 'text/plain', bytes: Buffer.from('dsh-work 契约测试：安全库存按七天用量计算。'),
    })
    assert.equal(uploaded.knowledgeBaseId, created.id)
    const listed = await client.listDocuments(created.id, { page: 1, pageSize: 20 })
    assert.ok(listed.items.some(item => item.id === uploaded.id))
    const [metadata] = await client.knowledgeBatch([uploaded.id])
    assert.equal(metadata?.knowledge_base_id, created.id, '文档归属校验依赖批量元数据接口')
    await client.updateDocumentTitle(uploaded.id, '契约测试文档')
    assert.ok((await client.downloadDocument(uploaded.id)).bytes.length > 0)
    await client.previewDocument(uploaded.id)
    await client.reparseDocument(uploaded.id)
    await client.deleteDocument(uploaded.id)
  } finally {
    await client.deleteKnowledgeBase(created.id)
  }
})
