import { createInterface } from 'node:readline'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

interface PendingPrompt {
  id: number
  sessionId: string
  answer: string
}

let sessionSequence = 0
let permissionSequence = 9000
const pendingPrompts = new Map<string, PendingPrompt>()
const permissionPrompts = new Map<number, PendingPrompt>()

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage
  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      },
    })
    return
  }

  if (message.method === 'session/new' && message.id !== undefined) {
    sessionSequence += 1
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: `mock-session-${sessionSequence}` } })
    return
  }

  if (message.method === 'session/prompt' && message.id !== undefined) {
    const sessionId = String(message.params?.['sessionId'] ?? '')
    const prompt = message.params?.['prompt']
    const text = Array.isArray(prompt)
      ? prompt.map(block => isRecord(block) && typeof block['text'] === 'string' ? block['text'] : '').join('')
      : ''
    const pending = { id: message.id, sessionId, answer: `Mock response: ${text}` }
    pendingPrompts.set(sessionId, pending)

    if (text.includes('[crash]')) process.exit(17)
    if (text.includes('[model-failure]')) {
      failPrompt(pending, 'Model invocation failed', 'model')
      return
    }
    if (text.includes('[tool-timeout]')) {
      failPrompt(pending, 'Tool invocation timed out', 'tool_timeout')
      return
    }
    if (text.includes('[network-failure]')) {
      failPrompt(pending, 'Network connection unavailable', 'network')
      return
    }
    if (text.includes('[hang]')) return
    if (text.includes('[unexpected-cancel]')) {
      finishPrompt(pending, 'cancelled', false)
      return
    }
    if (text.includes('[permission]')) {
      const requestId = permissionSequence++
      permissionPrompts.set(requestId, pending)
      send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params: {
          sessionId,
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: { toolCallId: 'mock-tool-call', title: 'Mock read-only tool' },
        },
      })
      return
    }
    finishPrompt(pending, 'end_turn')
    return
  }

  if (message.method === 'session/cancel') {
    const sessionId = String(message.params?.['sessionId'] ?? '')
    const pending = pendingPrompts.get(sessionId)
    if (pending !== undefined) finishPrompt(pending, 'cancelled', false)
    return
  }

  if (message.id !== undefined && permissionPrompts.has(message.id)) {
    const pending = permissionPrompts.get(message.id)
    permissionPrompts.delete(message.id)
    if (pending !== undefined) finishPrompt(pending, 'end_turn')
  }
})

function finishPrompt(pending: PendingPrompt, stopReason: string, includeAnswer = true): void {
  pendingPrompts.delete(pending.sessionId)
  if (includeAnswer) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: pending.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: pending.answer },
        },
      },
    })
  }
  send({ jsonrpc: '2.0', id: pending.id, result: { stopReason } })
}

function failPrompt(pending: PendingPrompt, message: string, category: string): void {
  pendingPrompts.delete(pending.sessionId)
  send({
    jsonrpc: '2.0',
    id: pending.id,
    error: { code: -32000, message, data: { category } },
  })
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
