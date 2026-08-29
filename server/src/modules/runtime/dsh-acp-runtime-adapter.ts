import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  AcpJsonRpcClient,
  type AcpPermissionRequest,
  type AcpProcessConfiguration,
  type AcpSessionUpdate,
} from './acp-json-rpc-client.ts'
import { compileRuntimeManifest } from './manifest-compiler.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeHealth,
  RuntimeManifest,
  RuntimeRunStatus,
} from './runtime-types.ts'

interface ExecutionRecord {
  manifest: RuntimeManifest
  snapshot: RuntimeExecutionSnapshot
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
  client?: AcpJsonRpcClient
  acpSessionId?: string
  timeout?: NodeJS.Timeout
  cancelCause?: 'user' | 'timeout' | 'shutdown'
  assistantText: string
  terminal: boolean
}

export interface DshAcpRuntimeAdapterConfiguration {
  runtimeId: string
  runtimeRoot: string
  dshRepository: string
  process: Omit<AcpProcessConfiguration, 'env'> & { env?: Record<string, string> }
  acceptingRuns?: boolean
  shutdownGraceMs?: number
  permissionDecision?: (
    request: AcpPermissionRequest,
    manifest: RuntimeManifest,
  ) => Promise<'allow_once' | 'reject_once'>
  now?: () => Date
}

export class DshAcpRuntimeAdapter implements AgentRuntimePort {
  private readonly configuration: DshAcpRuntimeAdapterConfiguration
  private readonly executions = new Map<string, ExecutionRecord>()
  private acceptingRuns: boolean
  private closed = false

  constructor(configuration: DshAcpRuntimeAdapterConfiguration) {
    this.configuration = configuration
    this.acceptingRuns = configuration.acceptingRuns ?? true
  }

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    if (this.closed) throw new Error('Runtime Adapter is closed')
    if (!this.acceptingRuns) throw new Error('Runtime Adapter is not accepting runs')
    if (this.executions.has(manifest.run_id)) throw new Error(`Run already exists: ${manifest.run_id}`)

    const compiled = compileRuntimeManifest(manifest)
    const attemptDirectory = resolve(
      this.configuration.runtimeRoot,
      safeSegment(manifest.user_context.tenant_id),
      safeSegment(manifest.run_id),
      safeSegment(manifest.attempt_id),
    )
    const workspaceDirectory = join(attemptDirectory, 'workspace')
    const outputDirectory = join(attemptDirectory, 'output')
    await mkdir(workspaceDirectory, { recursive: true })
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(join(attemptDirectory, 'manifest.json'), `${compiled.canonicalJson}\n`, { flag: 'wx' })

    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const acceptedAt = this.now()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt,
      startedAt: null,
      endedAt: null,
      manifestSha256: compiled.sha256,
      attemptDirectory,
      errorCode: null,
      errorMessage: null,
    }
    const record: ExecutionRecord = {
      manifest: compiled.manifest,
      snapshot,
      events: [],
      listeners: new Set(),
      done,
      resolveDone,
      assistantText: '',
      terminal: false,
    }
    this.executions.set(manifest.run_id, record)
    this.emit(record, 'run.queued', '任务已进入 Runtime 队列', { manifest_sha256: compiled.sha256 })
    void this.run(record, workspaceDirectory)

    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener): () => void {
    const record = this.executions.get(runId)
    if (record === undefined) throw new Error(`Run not found: ${runId}`)
    for (const event of record.events) listener(structuredClone(event))
    record.listeners.add(listener)
    return () => { record.listeners.delete(listener) }
  }

  async cancel(runId: string, requestedBy: string): Promise<{ accepted: boolean }> {
    const record = this.executions.get(runId)
    if (record === undefined || record.terminal) return { accepted: false }
    if (record.cancelCause !== undefined) return { accepted: true }

    record.cancelCause = 'user'
    this.setStatus(record, 'cancel_requested')
    this.emit(record, 'run.cancel_requested', '正在取消任务', { requested_by: requestedBy })
    if (record.client !== undefined && record.acpSessionId !== undefined) {
      await record.client.cancel(record.acpSessionId)
      this.scheduleForcedClose(record)
    } else if (record.client !== undefined) {
      this.scheduleForcedClose(record)
    }
    return { accepted: true }
  }

  status(runId: string): RuntimeExecutionSnapshot | undefined {
    const snapshot = this.executions.get(runId)?.snapshot
    return snapshot === undefined ? undefined : structuredClone(snapshot)
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await access(this.configuration.dshRepository)
      return {
        status: this.closed ? 'offline' : 'healthy',
        runtimeId: this.configuration.runtimeId,
        activeExecutions: [...this.executions.values()].filter(record => !record.terminal).length,
        acceptingRuns: this.acceptingRuns && !this.closed,
        dshRepository: this.configuration.dshRepository,
        transport: 'acp-stdio',
        message: this.closed ? 'Runtime Adapter 已关闭' : 'DSH 仓库可访问，ACP Adapter 可用',
      }
    } catch {
      return {
        status: 'offline',
        runtimeId: this.configuration.runtimeId,
        activeExecutions: 0,
        acceptingRuns: false,
        dshRepository: this.configuration.dshRepository,
        transport: 'acp-stdio',
        message: 'DSH 仓库不可访问',
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.acceptingRuns = false
    const active = [...this.executions.values()].filter(record => !record.terminal)
    for (const record of active) {
      record.cancelCause = 'shutdown'
      this.setStatus(record, 'cancel_requested')
      this.emit(record, 'run.cancel_requested', 'Runtime 正在关闭任务', { requested_by: 'runtime-shutdown' })
      if (record.client !== undefined && record.acpSessionId !== undefined) {
        await record.client.cancel(record.acpSessionId).catch(() => undefined)
        this.scheduleForcedClose(record)
      }
    }
    await Promise.all(active.map(record => record.done))
  }

  private async run(record: ExecutionRecord, workspaceDirectory: string): Promise<void> {
    try {
      this.setStatus(record, 'starting')
      record.timeout = setTimeout(() => {
        void this.timeout(record)
      }, record.manifest.limits.timeout_seconds * 1000)
      const client = AcpJsonRpcClient.launch(
        {
          ...this.configuration.process,
          shutdownGraceMs: this.configuration.shutdownGraceMs ?? this.configuration.process.shutdownGraceMs,
          env: {
            DSH_PERMISSION_MODE: 'workspace-write',
            DSH_SNAPSHOT_SESSIONS_ROOT: join(record.snapshot.attemptDirectory, 'sessions'),
            ...this.configuration.process.env,
          },
        },
        {
          onSessionUpdate: update => { this.onSessionUpdate(record, update) },
          onPermissionRequest: request => this.onPermissionRequest(record, request),
          onDiagnostic: message => {
            this.emitDiagnostic(record, message)
          },
        },
      )
      record.client = client
      await client.initialize()
      record.acpSessionId = await client.newSession(workspaceDirectory)
      if (record.cancelCause !== undefined) {
        if (record.cancelCause === 'timeout') this.finishFailed(record, 'RUN_TIMEOUT', 'Runtime execution timed out')
        else this.finishCancelled(record)
        return
      }
      this.setStatus(record, 'running')
      record.snapshot.startedAt = this.now()
      this.emit(record, 'run.started', 'DSH Worker 已启动', {
        transport: 'acp-stdio',
        acp_session_id: record.acpSessionId,
      })

      const response = await client.prompt(record.acpSessionId, record.manifest.input.message)
      const stopReason = response['stopReason']
      if (stopReason === 'cancelled' || record.cancelCause !== undefined) {
        if (record.cancelCause === 'timeout') {
          this.finishFailed(record, 'RUN_TIMEOUT', 'Runtime execution timed out')
        } else {
          this.finishCancelled(record)
        }
        return
      }

      if (record.assistantText.length > 0) {
        this.emit(record, 'assistant.completed', record.assistantText, { committed: true })
      }
      this.setStatus(record, 'completed')
      this.emit(record, 'run.completed', '任务执行完成', { stop_reason: stopReason ?? 'unknown' })
      this.finish(record)
    } catch (error) {
      if (record.cancelCause === 'timeout') this.finishFailed(record, 'RUN_TIMEOUT', 'Runtime execution timed out')
      else if (record.cancelCause !== undefined) this.finishCancelled(record)
      else this.finishFailed(record, 'RUNTIME_EXECUTION_FAILED', safeErrorMessage(error))
    } finally {
      if (record.timeout !== undefined) clearTimeout(record.timeout)
      await record.client?.close().catch(() => undefined)
    }
  }

  private onSessionUpdate(record: ExecutionRecord, notification: AcpSessionUpdate): void {
    if (record.terminal || notification.sessionId !== record.acpSessionId) return
    const updateType = notification.update['sessionUpdate']
    const content = notification.update['content']
    if (updateType !== 'agent_message_chunk' || !isRecord(content) || content['type'] !== 'text') return
    const text = content['text']
    if (typeof text !== 'string' || text.length === 0) return

    const remaining = record.manifest.limits.max_output_bytes - Buffer.byteLength(record.assistantText)
    if (remaining <= 0) return
    const bounded = truncateUtf8(text, remaining)
    record.assistantText += bounded
    this.emit(record, 'assistant.delta', bounded, { committed_block: true })
  }

  private async onPermissionRequest(
    record: ExecutionRecord,
    request: AcpPermissionRequest,
  ): Promise<{ outcome: Record<string, unknown> }> {
    this.emit(record, 'approval.required', 'DSH 请求一次性工具权限', {
      option_kinds: request.options?.map(option => option.kind).filter(Boolean) ?? [],
    })
    const decision = record.manifest.permission_policy.approval_mode === 'never'
      ? 'reject_once'
      : await this.configuration.permissionDecision?.(request, record.manifest) ?? 'reject_once'
    const desiredKind = decision
    const option = request.options?.find(candidate => candidate.kind === desiredKind)
    if (option?.optionId === undefined) {
      this.emit(record, 'approval.resolved', '权限请求已安全拒绝', { decision: 'cancelled' })
      return { outcome: { outcome: 'cancelled' } }
    }
    this.emit(record, 'approval.resolved', decision === 'allow_once' ? '已允许本次操作' : '已拒绝本次操作', {
      decision,
    })
    return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }

  private async timeout(record: ExecutionRecord): Promise<void> {
    if (record.terminal || record.cancelCause !== undefined) return
    record.cancelCause = 'timeout'
    this.setStatus(record, 'cancel_requested')
    this.emit(record, 'run.cancel_requested', '任务执行超时，正在终止', { reason: 'timeout' })
    if (record.client !== undefined && record.acpSessionId !== undefined) {
      await record.client.cancel(record.acpSessionId).catch(() => undefined)
      this.scheduleForcedClose(record)
    } else if (record.client !== undefined) {
      this.scheduleForcedClose(record)
    }
  }

  private scheduleForcedClose(record: ExecutionRecord): void {
    const timer = setTimeout(() => {
      if (!record.terminal) void record.client?.close().catch(() => undefined)
    }, this.configuration.shutdownGraceMs ?? 3000)
    timer.unref()
  }

  private finishCancelled(record: ExecutionRecord): void {
    if (record.terminal) return
    this.setStatus(record, 'cancelled')
    this.emit(record, 'run.cancelled', '任务已取消', { cause: record.cancelCause ?? 'user' })
    this.finish(record)
  }

  private finishFailed(record: ExecutionRecord, code: string, message: string): void {
    if (record.terminal) return
    record.snapshot.errorCode = code
    record.snapshot.errorMessage = message
    this.setStatus(record, 'failed')
    this.emit(record, 'run.failed', '任务执行失败', { error_code: code, reason: message })
    this.finish(record)
  }

  private finish(record: ExecutionRecord): void {
    if (record.terminal) return
    record.terminal = true
    record.snapshot.endedAt = this.now()
    record.resolveDone(structuredClone(record.snapshot))
  }

  private emit(
    record: ExecutionRecord,
    eventType: RuntimeEvent['event_type'],
    displayMessage: string | null,
    safeMetadata: Record<string, unknown>,
  ): void {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: record.manifest.run_id,
      attempt_id: record.manifest.attempt_id,
      sequence: record.events.length + 1,
      event_type: eventType,
      occurred_at: this.now(),
      display_message: displayMessage,
      safe_metadata: safeMetadata,
      trace_id: record.manifest.trace_id ?? record.manifest.run_id,
      parent_event_id: record.events.at(-1)?.event_id ?? null,
    }
    record.events.push(event)
    for (const listener of record.listeners) listener(structuredClone(event))
  }

  private emitDiagnostic(record: ExecutionRecord, message: string): void {
    if (message.length === 0 || record.terminal) return
    // Diagnostics are intentionally not exposed as a Run Event. They may contain
    // filesystem paths or provider details and belong in a redacted operator log.
  }

  private setStatus(record: ExecutionRecord, status: RuntimeRunStatus): void {
    record.snapshot.status = status
  }

  private now(): string {
    return (this.configuration.now?.() ?? new Date()).toISOString()
  }
}

function safeSegment(value: string): string {
  const readable = value.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let result = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    result += character
    bytes += characterBytes
  }
  return result
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replaceAll(/(sk-[A-Za-z0-9_-]{8,})/g, '[REDACTED]').slice(0, 1000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
