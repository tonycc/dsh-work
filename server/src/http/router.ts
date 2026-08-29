import type { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiMeta {
  api: 'workbench' | 'admin' | 'system'
  adapter: 'prototype-memory'
  timestamp: string
}

export interface ApiEnvelope<T> {
  data: T
  meta: ApiMeta
}

type RouteHandler = (request: IncomingMessage) => unknown | Promise<unknown>

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

export class Router {
  private readonly routes = new Map<string, RouteHandler>()

  get(path: string, handler: RouteHandler) {
    this.routes.set(`GET ${path}`, handler)
  }

  post(path: string, handler: RouteHandler) {
    this.routes.set(`POST ${path}`, handler)
  }

  patch(path: string, handler: RouteHandler) {
    this.routes.set(`PATCH ${path}`, handler)
  }

  async handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET, POST, PATCH, OPTIONS' })
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const route = this.routes.get(`${request.method ?? 'GET'} ${url.pathname}`)

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
      writeJson(response, 200, await route(request))
    } catch (error) {
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

export async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let body = ''
  for await (const chunk of request) {
    body += String(chunk)
    if (body.length > 1024 * 1024) throw new Error('请求体超过 1 MB 限制')
  }
  if (!body) throw new Error('请求体不能为空')
  return JSON.parse(body) as T
}

export function envelope<T>(api: ApiMeta['api'], data: T): ApiEnvelope<T> {
  return {
    data,
    meta: {
      api,
      adapter: 'prototype-memory',
      timestamp: new Date().toISOString(),
    },
  }
}
