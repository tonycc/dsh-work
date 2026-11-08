import type { ModelGatewayTextRestorer } from './model-gateway-types.ts'

type CreateRestorer = (encode?: (value: string) => string) => ModelGatewayTextRestorer
type Rewrite = (text: string) => string

/**
 * 这些字段不参与遮盖：协议结构、名称、图片数据，以及思考内容（双向原样透传，方案 5.4）。
 * 用排除而不是列举正文字段：协议新增的文本字段默认被遮盖，不会漏发原值。
 */
const SKIPPED_KEYS = new Set([
  'role', 'type', 'id', 'name', 'tool_call_id', 'tool_use_id', 'cache_control',
  'reasoning_content', 'thinking', 'signature', 'data', 'image_url', 'source',
])
const TEXT_ROOTS = ['messages', 'system'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 工具参数里的键是工具自己定义的（可能就叫 name、id），按全部取值处理。 */
function walkAll(node: unknown, rewrite: Rewrite): unknown {
  if (typeof node === 'string') return rewrite(node)
  if (Array.isArray(node)) return node.map(item => walkAll(item, rewrite))
  if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walkAll(value, rewrite)]))
  return node
}

/** 工具调用参数是 JSON 文本：在解码后的取值上处理，转义形式不会漏报；没有变化时保持原文。 */
function walkArguments(text: string, rewrite: Rewrite): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return rewrite(text)
  }
  if (parsed === null || typeof parsed !== 'object') return rewrite(text)
  const original = JSON.stringify(parsed)
  const updated = JSON.stringify(walkAll(parsed, rewrite))
  return updated === original ? text : updated
}

function walkMessage(node: unknown, rewrite: Rewrite): unknown {
  if (typeof node === 'string') return rewrite(node)
  if (Array.isArray(node)) return node.map(item => walkMessage(item, rewrite))
  if (!isRecord(node)) return node
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'arguments' && typeof value === 'string') output[key] = walkArguments(value, rewrite)
    else if (key === 'input') output[key] = walkAll(value, rewrite)
    else if (SKIPPED_KEYS.has(key)) output[key] = value
    else output[key] = walkMessage(value, rewrite)
  }
  return output
}

function walkRequest(body: Record<string, unknown>, rewrite: Rewrite): Record<string, unknown> {
  const output = { ...body }
  for (const root of TEXT_ROOTS) {
    if (root in output) output[root] = walkMessage(output[root], rewrite)
  }
  return output
}

/** 收集请求中要遮盖的全部文本，遮盖后按相同顺序写回。 */
export function collectRequestTexts(body: Record<string, unknown>): string[] {
  const texts: string[] = []
  walkRequest(body, text => {
    texts.push(text)
    return text
  })
  return texts
}

export function applyRequestTexts(body: Record<string, unknown>, texts: readonly string[]): Record<string, unknown> {
  let index = 0
  return walkRequest(body, () => texts[index++]!)
}

export function requestHasImage(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(requestHasImage)
  if (!isRecord(node)) return false
  if ('image_url' in node || node['type'] === 'image') return true
  return Object.entries(node).some(([key, value]) => key !== 'data' && key !== 'source' && requestHasImage(value))
}

const jsonEscape = (value: string) => JSON.stringify(value).slice(1, -1)

function restoreText(text: string, restorer: ModelGatewayTextRestorer): string {
  return restorer.push(text) + restorer.flush()
}

/** 还原非流式回复；思考内容不动。 */
export function restoreJsonResponse(body: Record<string, unknown>, createRestorer: CreateRestorer): Record<string, unknown> {
  if (Array.isArray(body['choices'])) {
    for (const choice of body['choices']) {
      const message = isRecord(choice) ? choice['message'] : undefined
      if (!isRecord(message)) continue
      if (typeof message['content'] === 'string') message['content'] = restoreText(message['content'], createRestorer())
      if (!Array.isArray(message['tool_calls'])) continue
      for (const call of message['tool_calls']) {
        const fn = isRecord(call) ? call['function'] : undefined
        if (isRecord(fn) && typeof fn['arguments'] === 'string') fn['arguments'] = restoreText(fn['arguments'], createRestorer(jsonEscape))
      }
    }
  }
  if (Array.isArray(body['content'])) {
    for (const block of body['content']) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') block['text'] = restoreText(block['text'], createRestorer())
      else if (isRecord(block['input'])) block['input'] = walkAll(block['input'], text => restoreText(text, createRestorer()))
    }
  }
  return body
}

interface Slot {
  restorer: ModelGatewayTextRestorer
  /** 把扣住的尾部组成一个补发事件。 */
  emit: (tail: string) => string
}

/**
 * 按 SSE 事件还原回复（OpenAI 兼容与 Anthropic 兼容）。每个文本字段一个还原器，占位符跨事件时
 * 尾部留到下一事件；该字段结束前补发扣住的尾部。思考内容字段不处理，未改动的事件原样放行。
 */
export class SseResponseRestorer {
  private readonly createRestorer: CreateRestorer
  private readonly slots = new Map<string, Slot>()
  private pending = ''

  constructor(createRestorer: CreateRestorer) {
    this.createRestorer = createRestorer
  }

  push(text: string): string {
    this.pending += text
    let output = ''
    for (let match = /\r?\n\r?\n/.exec(this.pending); match; match = /\r?\n\r?\n/.exec(this.pending)) {
      const end = match.index + match[0].length
      output += this.processEvent(this.pending.slice(0, match.index), this.pending.slice(match.index, end))
      this.pending = this.pending.slice(end)
    }
    return output
  }

  finish(): string {
    const rest = this.pending
    this.pending = ''
    return (rest.trim() ? this.processEvent(rest, '\n\n') : rest) + this.flushSlots(() => true)
  }

  private slot(key: string, encode: ((value: string) => string) | undefined, emit: Slot['emit']): Slot {
    let slot = this.slots.get(key)
    if (!slot) {
      slot = { restorer: this.createRestorer(encode), emit }
      this.slots.set(key, slot)
    }
    return slot
  }

  private flushSlots(matches: (key: string) => boolean): string {
    let output = ''
    for (const [key, slot] of [...this.slots]) {
      if (!matches(key)) continue
      const tail = slot.restorer.flush()
      if (tail) output += slot.emit(tail)
      this.slots.delete(key)
    }
    return output
  }

  private processEvent(block: string, separator: string): string {
    const raw = block + separator
    const lines = block.split(/\r?\n/)
    const dataLines = lines.filter(line => line.startsWith('data:'))
    if (dataLines.length === 0) return raw
    const payload = dataLines.map(line => line.slice(5).trim()).join('\n')
    if (payload === '[DONE]') return this.flushSlots(() => true) + raw
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return raw
    }
    if (!isRecord(event)) return raw
    const before = Array.isArray(event['choices']) ? this.restoreChatEvent(event) : this.restoreAnthropicEvent(event)
    const updated = JSON.stringify(event)
    if (updated === JSON.stringify(JSON.parse(payload))) return before + raw
    const others = lines.filter(line => !line.startsWith('data:'))
    return `${before}${[...others, `data: ${updated}`].join('\n')}\n\n`
  }

  private restoreChatEvent(event: Record<string, unknown>): string {
    const { choices: _choices, usage: _usage, ...meta } = event
    let before = ''
    for (const choice of event['choices'] as unknown[]) {
      if (!isRecord(choice)) continue
      const index = choice['index'] ?? 0
      const synthetic = (delta: unknown) => `data: ${JSON.stringify({ ...meta, choices: [{ index, delta, finish_reason: null }] })}\n\n`
      const delta = choice['delta']
      if (isRecord(delta)) {
        if (typeof delta['content'] === 'string') {
          const slot = this.slot(`${index}:content`, undefined, tail => synthetic({ content: tail }))
          delta['content'] = slot.restorer.push(delta['content'])
        }
        for (const call of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
          const fn = isRecord(call) ? call['function'] : undefined
          if (!isRecord(call) || !isRecord(fn) || typeof fn['arguments'] !== 'string') continue
          const callIndex = call['index'] ?? 0
          const slot = this.slot(`${index}:tool:${callIndex}`, jsonEscape, tail => synthetic({ tool_calls: [{ index: callIndex, function: { arguments: tail } }] }))
          fn['arguments'] = slot.restorer.push(fn['arguments'])
        }
      }
      if (choice['finish_reason']) before += this.flushSlots(key => key.startsWith(`${index}:`))
    }
    return before
  }

  private restoreAnthropicEvent(event: Record<string, unknown>): string {
    const index = event['index']
    if (event['type'] === 'content_block_stop') return this.flushSlots(key => key === `block:${index}`)
    const delta = event['delta']
    if (event['type'] !== 'content_block_delta' || !isRecord(delta)) return ''
    const field = delta['type'] === 'text_delta' ? 'text' : delta['type'] === 'input_json_delta' ? 'partial_json' : undefined
    if (!field || typeof delta[field] !== 'string') return ''
    const type = delta['type']
    const slot = this.slot(`block:${index}`, field === 'text' ? undefined : jsonEscape, tail =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type, [field]: tail } })}\n\n`)
    delta[field] = slot.restorer.push(delta[field])
    return ''
  }
}
