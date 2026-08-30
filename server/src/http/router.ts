import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiMeta {
  api: 'workbench' | 'admin' | 'system'
  adapter: 'prototype-memory' | 'postgres'
  timestamp: string
}

export interface ApiEnvelope<T> {
  data: T
  meta: ApiMeta
}

export interface RouteContext {
  params: Record<string, string>
  url: URL
}

export interface HttpResult {
  status: number
  body: unknown
}

type RouteHandler = (
  request: IncomingMessage,
  context: RouteContext,
  response: ServerResponse,
) => unknown | Promise<unknown>

interface RouteDefinition {
  method: string
  pattern: RegExp
  parameterNames: string[]
  handler: RouteHandler
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

export class Router {
  private readonly routes: RouteDefinition[] = []

  get(path: string, handler: RouteHandler) {
    this.register('GET', path, handler)
  }

  post(path: string, handler: RouteHandler) {
    this.register('POST', path, handler)
  }

  patch(path: string, handler: RouteHandler) {
    this.register('PATCH', path, handler)
  }

  private register(method: string, path: string, handler: RouteHandler) {
    const parameterNames: string[] = []
    const source = path
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return escapeRegExp(segment)
        parameterNames.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), parameterNames, handler })
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET, POST, PATCH, OPTIONS' })
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const method = request.method ?? 'GET'
    const route = this.routes.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname))

    if (!route) {
      writeJson(response, 404, {
        error: {
          code: 'route_not_found',
          message: `没有找到 ${request.method ?? 'GET'} ${url.pathname}`,
        },
      })
      return
    }

    try {
      const match = route.pattern.exec(url.pathname)
      const params = Object.fromEntries(
        route.parameterNames.map((name, index) => [name, decodeURIComponent(match?.[index + 1] ?? '')]),
      )
      const result = await route.handler(request, { params, url }, response)
      if (response.headersSent || response.writableEnded) return
      if (isHttpResult(result)) writeJson(response, result.status, result.body)
      else writeJson(response, 200, result)
    } catch (error) {
      if (response.headersSent || response.writableEnded) {
        response.end()
        return
      }
      const message = error instanceof Error ? error.message : '未知服务端错误'
      writeJson(response, 500, {
        error: {
          code: 'internal_error',
          message,
        },
      })
    }
  }
}

export function httpResult(status: number, body: unknown): HttpResult {
  return { status, body }
}

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 1024 * 1024) throw new Error('请求体超过 1 MB 限制')
  }
  if (!body) throw new Error('请求体不能为空')
  return JSON.parse(body) as T
}

export function envelope<T>(api: ApiMeta['api'], data: T, adapter: ApiMeta['adapter'] = 'prototype-memory'): ApiEnvelope<T> {
  return {
    data,
    meta: {
      api,
      adapter,
      timestamp: new Date().toISOString(),
    },
  }
}

function isHttpResult(value: unknown): value is HttpResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
