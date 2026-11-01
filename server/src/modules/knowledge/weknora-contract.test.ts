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
  } finally {
    await client.deleteKnowledgeBase(created.id)
  }
})
