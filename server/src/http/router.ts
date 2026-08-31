import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

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
          object: '当前接口',
          suggestion: '请刷新页面；若问题持续，请确认前后端版本一致。',
          traceId: `trace-http-${randomUUID()}`,
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
      const failure = classifyHttpError(error, url.pathname)
      writeJson(response, failure.status, { error: failure.error })
    }
  }
}

export interface HttpErrorDetail {
  code: string
  message: string
  object: string
  suggestion: string
  traceId: string
}

export function classifyHttpError(error: unknown, path: string): { status: number; error: HttpErrorDetail } {
  const original = error instanceof Error ? error.message : '未知服务端错误'
  const normalized = original.toLowerCase()
  const object = inferRequestObject(path)
  const traceId = `trace-http-${randomUUID()}`

  if (error instanceof SyntaxError) {
    return { status: 422, error: { code: 'invalid_request', message: `${object}请求内容不是有效 JSON`, object, suggestion: '检查请求字段和 JSON 格式后重新提交。', traceId } }
  }
  if (normalized.includes('超时') || normalized.includes('timeout')) {
    return { status: 504, error: { code: 'dependency_timeout', message: `${object}处理超时`, object, suggestion: '稍后重试；若持续发生，请管理员检查运行时或连接器健康状态。', traceId } }
  }
  if (/没有.*权限|不可访问|不是成员|不可调用|未授权|不是平台管理员/.test(original)) {
    return { status: 403, error: { code: 'permission_denied', message: original, object, suggestion: '确认当前账号、工作空间成员关系和数据范围；需要时联系管理员授权。', traceId } }
  }
  if (/不存在|没有找到/.test(original)) {
    return { status: 404, error: { code: 'resource_not_found', message: original, object, suggestion: '返回列表确认对象仍存在，然后重新选择。', traceId } }
  }
  if (/离线|不可用|未处于健康状态|健康检查/.test(original)) {
    return { status: 503, error: { code: 'dependency_unavailable', message: original, object, suggestion: '请管理员检查运行时或连接器状态，恢复后再重试。', traceId } }
  }
  if (/当前状态|只有.*可以|不能/.test(original)) {
    return { status: 409, error: { code: 'state_conflict', message: original, object, suggestion: '刷新对象状态后，按页面允许的操作继续。', traceId } }
  }
  if (/必须|仅支持|至少|最多|超过|无效|不能为空|缺少|长度|大小/.test(original)) {
    return { status: 422, error: { code: 'invalid_request', message: original, object, suggestion: '按提示调整输入内容或文件后重新提交。', traceId } }
  }
  return { status: 500, error: { code: 'operation_failed', message: `${object}操作未完成`, object, suggestion: `稍后重试；若问题持续，请将链路编号 ${traceId} 提供给管理员。`, traceId } }
}

function inferRequestObject(path: string) {
  const segments = path.split('/').filter(Boolean)
  const mappings: Array<[string, string]> = [
    ['artifacts', '成果'], ['files', '文件'], ['connectors', '连接器'], ['runtimes', '运行时'],
    ['runs', '运行'], ['sessions', '对话'], ['workspaces', '工作空间'], ['agents', 'Agent'], ['skills', 'Skill'],
  ]
  for (const [segment, label] of mappings) {
    const index = segments.indexOf(segment)
    if (index >= 0) return `${label}${segments[index + 1] ? ` ${segments[index + 1]}` : ''}`
  }
  return '当前请求'
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
