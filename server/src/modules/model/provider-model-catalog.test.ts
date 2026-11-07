import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import { HttpProviderModelCatalog, parseModelIds } from './provider-model-catalog.ts'

describe('厂商模型目录（HTTP）', () => {
  let server: Server
  let baseUrl = ''
  const seen: Array<{ url?: string; authorization?: string }> = []

  before(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization })
      if (request.headers.authorization !== 'Bearer vendor-secret') {
        response.writeHead(401).end('{"error":"invalid key"}')
        return
      }
      if (request.url === '/slow/models') return // 不响应，触发超时
      if (request.url === '/missing/models') { response.writeHead(404).end(); return }
      if (request.url === '/broken/models') { response.writeHead(200, { 'content-type': 'application/json' }).end('not json'); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-max' }, { id: 'qwen3.8-flash' }, { id: 'qwen-max' }, { object: 'model' }] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const catalog = (secret = 'vendor-secret') => new HttpProviderModelCatalog({ readSecret: async () => secret, timeoutMs: 300 })

  it('以 Bearer 密钥请求 {base_url}/models，去重并排序', async () => {
    const ids = await catalog().list({ tenantId: 't', credentialRefId: 'c', baseUrl: `${baseUrl}/v1/` })
    assert.deepEqual(ids, ['qwen-max', 'qwen3.8-flash'])
    assert.deepEqual(seen.at(-1), { url: '/v1/models', authorization: 'Bearer vendor-secret' })
  })

  it('密钥被拒时给出可操作的提示，且不回显密钥', async () => {
    await assert.rejects(catalog('wrong-secret').list({ tenantId: 't', credentialRefId: 'c', baseUrl }), (error: Error) => {
      assert.match(error.message, /拒绝了该 API Key/)
      assert.doesNotMatch(error.message, /wrong-secret/)
      return true
    })
  })

  it('厂商不提供 /models、返回非 JSON 或超时都明确报错，提示手动填写', async () => {
    await assert.rejects(catalog().list({ tenantId: 't', credentialRefId: 'c', baseUrl: `${baseUrl}/missing` }), /HTTP 404.*手动填写/)
    await assert.rejects(catalog().list({ tenantId: 't', credentialRefId: 'c', baseUrl: `${baseUrl}/broken` }), /无法解析/)
    await assert.rejects(catalog().list({ tenantId: 't', credentialRefId: 'c', baseUrl: `${baseUrl}/slow` }), /无法连接厂商/)
  })

  it('读取密钥失败时不发请求', async () => {
    const before = seen.length
    const failing = new HttpProviderModelCatalog({ readSecret: async () => { throw new Error('decrypt failed') } })
    await assert.rejects(failing.list({ tenantId: 't', credentialRefId: 'c', baseUrl }), /无法读取该 Provider 的 API Key/)
    assert.equal(seen.length, before)
  })
})

describe('parseModelIds', () => {
  it('兼容 data 与 models 两种形态', () => {
    assert.deepEqual(parseModelIds({ data: [{ id: 'b' }, 'a'] }), ['a', 'b'])
    assert.deepEqual(parseModelIds({ models: [{ name: 'glm-5' }] }), ['glm-5'])
    assert.throws(() => parseModelIds({ foo: [] }), /格式不符合/)
  })
})
