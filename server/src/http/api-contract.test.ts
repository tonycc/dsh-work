import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import { PrototypeRepository } from '../infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from '../modules/admin/application/admin-query-service.ts'
import { WorkbenchQueryService } from '../modules/workbench/application/workbench-query-service.ts'
import { registerAdminRoutes } from './admin/routes.ts'
import { Router } from './router.ts'
import { registerWorkbenchRoutes } from './workbench/routes.ts'
import { registerUnavailableWorkbenchCommandRoutes } from './workbench/unavailable-routes.ts'

let server: Server
let baseUrl = ''

interface SessionEnvelope {
  data: { user: { role: string } }
  meta: { api: string; adapter: string }
}

interface ErrorEnvelope {
  error: { code: string; message: string; object: string; suggestion: string; traceId: string }
}

interface AgentEnvelope {
  data: Array<{ id: string; status?: string; systemPrompt?: string; owner?: string }>
  meta: { api: string; adapter: string }
}

interface WorkspaceEnvelope {
  data: Array<{ id: string; type: 'personal' | 'team'; name: string }>
}

interface OperationsSummaryEnvelope {
  data: { runs24h: number; modelTokens24h: number; attentionEvents24h: number }
  meta: { adapter: string }
}

interface AgentTestEnvelope {
  data: { agentId: string; version: string; status: string }
  meta: { adapter: string }
}

before(async () => {
  const repository = new PrototypeRepository()
  const router = new Router()
  registerUnavailableWorkbenchCommandRoutes(router)
  registerWorkbenchRoutes(router, new WorkbenchQueryService(repository))
  registerAdminRoutes(router, new AdminQueryService(repository))
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('测试 HTTP Server 没有获得端口')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

test('workbench and admin audiences return distinct typed envelopes', async () => {
  const workbench = await getJson<SessionEnvelope>('/api/workbench/v1/session')
  assert.equal(workbench.response.status, 200)
  assert.equal(workbench.body.meta.api, 'workbench')
  assert.equal(workbench.body.meta.adapter, 'prototype-memory')
  assert.equal(workbench.body.data.user.role, 'employee')

  const admin = await getJson<SessionEnvelope>('/api/admin/v1/session')
  assert.equal(admin.response.status, 200)
  assert.equal(admin.body.meta.api, 'admin')
  assert.equal(admin.body.data.user.role, 'platform_admin')
})

test('audience-specific routes do not leak into the other API namespace', async () => {
  const result = await getJson<ErrorEnvelope>('/api/workbench/v1/runtimes')
  assert.equal(result.response.status, 404)
  assert.equal(result.body.error.code, 'route_not_found')
  assert.equal(result.body.error.object, '当前接口')
  assert.match(result.body.error.traceId, /^trace-http-/)
})

test('prototype workbench Agent DTO exposes only published employee-safe fields', async () => {
  const result = await getJson<AgentEnvelope>('/api/workbench/v1/agents')
  assert.equal(result.response.status, 200)
  assert.ok(result.body.data.length >= 1)
  assert.ok(result.body.data.every(agent => agent.status === undefined))
  assert.ok(result.body.data.every(agent => agent.systemPrompt === undefined))
  assert.ok(result.body.data.every(agent => agent.owner === undefined))
})

test('prototype workbench exposes exactly one default personal workspace', async () => {
  const result = await getJson<WorkspaceEnvelope>('/api/workbench/v1/workspaces')
  assert.equal(result.response.status, 200)
  const personal = result.body.data.filter(workspace => workspace.type === 'personal')
  assert.equal(personal.length, 1)
  assert.equal(personal[0]?.name, '我的空间')
})

test('prototype admin exposes the operations summary required by the global store', async () => {
  const result = await getJson<OperationsSummaryEnvelope>('/api/admin/v1/operations/summary')
  assert.equal(result.response.status, 200)
  assert.equal(result.body.meta.adapter, 'prototype-memory')
  assert.ok(result.body.data.runs24h > 0)
  assert.ok(result.body.data.modelTokens24h > 0)
  assert.ok(result.body.data.attentionEvents24h >= 0)
})

test('prototype admin can validate a draft Agent before publishing', async () => {
  const response = await fetch(`${baseUrl}/api/admin/v1/agents/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'operations-analyst',
      prompt: '分析本月订单交付情况',
      actor: '陈默',
    }),
  })
  const body = await response.json() as AgentTestEnvelope
  assert.equal(response.status, 200)
  assert.equal(body.meta.adapter, 'prototype-memory')
  assert.equal(body.data.agentId, 'operations-analyst')
  assert.equal(body.data.status, 'passed')
})

test('prototype mode explains that conversation commands require PostgreSQL instead of returning a route 404', async () => {
  const response = await fetch(`${baseUrl}/api/workbench/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '测试对话' }),
  })
  const body = await response.json() as ErrorEnvelope

  assert.equal(response.status, 503)
  assert.equal(body.error.code, 'workbench_runtime_not_configured')
  assert.equal(body.error.object, '对话')
  assert.match(body.error.message, /PostgreSQL|运行时/)
  assert.match(body.error.suggestion, /DSH_WORK_DATABASE_URL/)
  assert.match(body.error.traceId, /^trace-http-/)
})

test('malformed management payloads use the shared actionable error contract', async () => {
  const response = await fetch(`${baseUrl}/api/admin/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":',
  })
  const body = await response.json() as ErrorEnvelope
  assert.equal(response.status, 422)
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message', 'object', 'suggestion', 'traceId'].sort())
  assert.equal(body.error.code, 'invalid_request')
  assert.equal(body.error.object, 'Agent')
})

async function getJson<T>(path: string) {
  const response = await fetch(`${baseUrl}${path}`)
  return { response, body: await response.json() as T }
}
