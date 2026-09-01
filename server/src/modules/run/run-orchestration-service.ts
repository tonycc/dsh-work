import { randomUUID } from 'node:crypto'

import type { ModelGovernanceService } from '../model/model-governance-service.ts'
import type { AgentRuntimePort, RuntimeEvent, RuntimeManifest } from '../runtime/runtime-types.ts'
import { compileRuntimeManifest } from '../runtime/manifest-compiler.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import type { PostgresContentService, PreparedRuntimeFile } from '../workbench/application/postgres-content-service.ts'
import type { PostgresOperationsService } from '../admin/application/postgres-operations-service.ts'
import type { PostgresAgentService } from '../agent/postgres-agent-service.ts'
import type { PostgresKnowledgeService } from '../knowledge/postgres-knowledge-service.ts'
import type {
  PostgresAuthorizationService,
  RuntimeAuthorizationDecision,
  SessionAuthorizationContext,
} from '../authorization/postgres-authorization-service.ts'
import type { RunRepository } from './run-repository.ts'
import type { JsonObject, RunRecord, StoredRunEvent } from './run-types.ts'

const tenantId = 'tenant-dsh-work'
const runtimeId = 'runtime-local-01'

export class RunOrchestrationService {
  private readonly eventWrites = new Map<string, Promise<void>>()
  private readonly assistantOutputs = new Map<string, string>()
  private readonly pendingExecutions: Array<{ run: RunRecord; manifest: RuntimeManifest }> = []
  private schedulerTimer?: NodeJS.Timeout
  private pumping = false
  private closing = false
  private readonly runs: RunRepository
  private readonly conversations: PostgresConversationRepository
  private readonly models: ModelGovernanceService
  private readonly runtime: AgentRuntimePort
  private readonly content?: PostgresContentService
  private readonly operations?: PostgresOperationsService
  private readonly agents?: PostgresAgentService
  private readonly knowledge?: PostgresKnowledgeService
  private readonly authorization?: PostgresAuthorizationService

  constructor(
    runs: RunRepository,
    conversations: PostgresConversationRepository,
    models: ModelGovernanceService,
    runtime: AgentRuntimePort,
    content?: PostgresContentService,
    operations?: PostgresOperationsService,
    agents?: PostgresAgentService,
    knowledge?: PostgresKnowledgeService,
    authorization?: PostgresAuthorizationService,
  ) {
    this.runs = runs
    this.conversations = conversations
    this.models = models
    this.runtime = runtime
    this.content = content
    this.operations = operations
    this.agents = agents
    this.knowledge = knowledge
    this.authorization = authorization
  }

  async createSession(input: {
    userId: string
    title: string
    workspaceId?: string
    agentVersionId?: string
    authorizationContext?: SessionAuthorizationContext
  }) {
    assertPrompt(input.title)
    const workspaceId = await this.conversations.resolveWorkspaceId(input.workspaceId, input.userId)
    if (this.authorization && input.agentVersionId) {
      await this.authorization.authorizeRuntime({
        userId: input.userId,
        workspaceId,
        agentVersionId: input.agentVersionId,
        ...input.authorizationContext,
      })
    } else {
      await this.authorization?.authorizeWorkbench({
        userId: input.userId,
        workspaceId,
        ...input.authorizationContext,
      })
    }
    return this.conversations.createSession({
      userId: input.userId,
      title: input.title,
      workspaceId,
      agentVersionId: input.agentVersionId,
    })
  }

  async startRun(input: {
    userId: string
    sessionId: string
    prompt: string
    idempotencyKey: string
    fileIds?: string[]
    authorizationContext?: SessionAuthorizationContext
  }) {
    assertPrompt(input.prompt)
    const session = await this.conversations.requireSession(input.sessionId, input.userId)
    const authorization = await this.authorization?.authorizeRuntime({
      userId: input.userId,
      workspaceId: session.workspaceId,
      agentVersionId: session.agentVersionId,
      ...input.authorizationContext,
    })
    const preparedFiles = this.content
      ? await this.content.prepareRuntimeFiles({
          sessionId: session.id,
          fileIds: input.fileIds ?? [],
          userId: input.userId,
        })
      : []
    const run = await this.runs.createRun({
      tenantId,
      sessionId: session.id,
      requestedBy: input.userId,
      idempotencyKey: input.idempotencyKey,
    })
    if (run.currentAttemptId) return run
    await this.conversations.appendMessage({
      sessionId: session.id,
      runId: run.id,
      role: 'user',
      content: input.prompt.trim(),
      messageId: `message-user-${run.id}`,
    })
    await this.dispatch(run, {
      prompt: input.prompt,
      workspaceId: session.workspaceId,
      agentVersionId: session.agentVersionId,
      userId: input.userId,
      fileIds: input.fileIds ?? [],
      preparedFiles,
      authorization,
    })
    await this.operations?.appendAudit(input.userId, 'run.create', run.id, 'success', `trace-${run.id}`, '员工创建真实 Run')
    return this.runs.getRun(tenantId, run.id)
  }

  async cancel(runId: string, userId: string, authorizationContext?: SessionAuthorizationContext) {
    await this.authorization?.authorizeWorkbench({ userId, ...authorizationContext })
    const run = await this.requireOwnedRun(runId, userId)
    if (!['queued', 'running', 'cancel_requested'].includes(run.status)) return run
    const result = await this.runtime.cancel(runId, userId)
    await this.operations?.appendAudit(userId, 'run.cancel.request', runId, 'success', `trace-${runId}`, '员工请求取消当前 Attempt')
    if (!result.accepted && run.status === 'queued') {
      if (run.currentAttemptId) await this.runs.transitionAttempt(tenantId, run.currentAttemptId, 'cancelled')
      return this.runs.transitionRun(tenantId, runId, 'cancelled')
    }
    return this.runs.getRun(tenantId, runId)
  }

  async retry(runId: string, userId: string, authorizationContext?: SessionAuthorizationContext) {
    const run = await this.requireOwnedRun(runId, userId)
    if (!['failed', 'cancelled'].includes(run.status)) throw new Error('只有失败或已取消的 Run 可以重试')
    const session = await this.conversations.requireSession(run.sessionId, userId)
    const authorization = await this.authorization?.authorizeRuntime({
      userId,
      workspaceId: session.workspaceId,
      agentVersionId: session.agentVersionId,
      ...authorizationContext,
    })
    const prompt = await this.conversations.getRunPrompt(run.id)
    const fileIds = this.content ? await this.content.getRunInputFileIds(run.id) : []
    await this.dispatch(run, {
      prompt,
      workspaceId: session.workspaceId,
      agentVersionId: session.agentVersionId,
      userId,
      fileIds,
      authorization,
    })
    await this.operations?.appendAudit(userId, 'run.retry', runId, 'success', `trace-${runId}`, '员工创建新的不可变 Attempt')
    return this.runs.getRun(tenantId, run.id)
  }

  async recoverAfterServiceRestart() {
    const recovery = await this.runs.recoverAfterRestart(tenantId, runtimeId)
    for (const item of recovery.failed) {
      await this.operations?.appendAudit(
        'system',
        'run.recovered-after-restart',
        item.runId,
        'failed',
        `trace-recovery-${item.runId}`,
        `Attempt ${item.attemptId} 因服务重启终止`,
      )
    }
    for (const item of recovery.queued) {
      this.pendingExecutions.push({
        run: item.run,
        manifest: item.attempt.manifest as unknown as RuntimeManifest,
      })
    }
    if (recovery.queued.length > 0) void this.pumpScheduler()
    return { failed: recovery.failed.length, resumedQueued: recovery.queued.length }
  }

  async close() {
    this.closing = true
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer)
    this.schedulerTimer = undefined
    await this.runtime.close()
    await Promise.all(this.eventWrites.values())
  }

  private async dispatch(run: RunRecord, input: {
    prompt: string
    workspaceId: string
    agentVersionId: string
    userId: string
    fileIds: string[]
    preparedFiles?: PreparedRuntimeFile[]
    authorization?: RuntimeAuthorizationDecision
  }) {
    const route = await this.models.resolveRoute('default')
    const runtimePolicy = await this.operations?.getRuntimePolicy(runtimeId)
    const agent = this.agents
      ? await this.agents.getRuntimeSnapshot(input.agentVersionId)
      : {
          versionId: input.agentVersionId,
          systemPrompt: '你是 dsh-work 企业员工助手。请给出准确、简洁、可执行的中文回答。',
          skills: [],
          skillInstructions: [],
          tools: [],
          runtimeTools: [],
          approvalMode: 'risk_based' as const,
          roleIds: ['role-employee'],
          dataScopes: ['enterprise:authorized'],
          maxTokens: 12000,
          timeoutSeconds: 300,
        }
    const authorization = input.authorization ?? await this.authorization?.authorizeRuntime({
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentVersionId: input.agentVersionId,
    })
    const effectiveDataScopes = authorization?.dataScopes ?? agent.dataScopes
    const knowledgeContext = this.knowledge
      ? await this.knowledge.resolveContext({
          query: input.prompt,
          userId: input.userId,
          workspaceId: input.workspaceId,
          dataScopes: effectiveDataScopes,
          roleIds: authorization?.roleIds,
        })
      : []
    const preparedFiles = input.preparedFiles ?? (this.content
      ? await this.content.prepareRuntimeFiles({
          sessionId: run.sessionId,
          fileIds: input.fileIds,
          userId: input.userId,
        })
      : [])
    const attemptId = `attempt-${randomUUID()}`
    const manifest: RuntimeManifest = {
      manifest_version: '1.0',
      run_id: run.id,
      attempt_id: attemptId,
      session_id: run.sessionId,
      workspace_id: input.workspaceId,
      agent_version_id: input.agentVersionId,
      agent_configuration: {
        system_prompt: agent.systemPrompt,
        skill_instructions: agent.skillInstructions.map(skill => ({
          id: skill.id,
          version: skill.version,
          instructions: skill.instructions,
        })),
      },
      user_context: {
        user_id: input.userId,
        tenant_id: tenantId,
        role_ids: authorization?.roleIds ?? agent.roleIds,
      },
      permission_policy: {
        approval_mode: agent.approvalMode,
        network_policy: 'deny',
        write_policy: 'workspace_only',
      },
      skills: agent.skills.map(toCapabilityReference),
      tools: agent.runtimeTools.map(toCapabilityReference),
      data_scopes: effectiveDataScopes,
      knowledge_context: knowledgeContext.map(document => ({
        documentId: document.documentId,
        title: document.title,
        version: document.version,
        effectiveDate: document.effectiveDate,
        dataScope: document.dataScope,
        contentChecksum: document.contentChecksum,
        excerpt: document.excerpt,
      })),
      model_route_id: route.routeId,
      input: { message: input.prompt.trim(), file_mounts: preparedFiles.map(file => file.mount) },
      limits: {
        timeout_seconds: Math.min(agent.timeoutSeconds, runtimePolicy?.timeoutSeconds ?? agent.timeoutSeconds),
        max_output_bytes: Math.min(agent.maxTokens * 4, 1024 * 1024),
        max_tool_calls: 20,
      },
      created_at: new Date().toISOString(),
      trace_id: `trace-${run.id}-${attemptId}`,
    }
    const compiled = compileRuntimeManifest(manifest)
    await this.runs.createAttempt({
      attemptId,
      tenantId,
      runId: run.id,
      runtimeId,
      manifest: JSON.parse(compiled.canonicalJson) as JsonObject,
      manifestSha256: compiled.sha256,
      modelRouteSnapshot: JSON.parse(JSON.stringify(route)) as JsonObject,
      knowledgeSources: knowledgeContext.map(document => ({
        documentId: document.documentId,
        relevanceScore: document.relevanceScore,
        excerpt: document.excerpt,
      })),
      inputFiles: preparedFiles.map(file => ({
        fileId: file.fileId,
        extractionId: file.extractionId,
        mountPath: file.mount.mount_path,
      })),
    })

    this.pendingExecutions.push({ run, manifest })
    void this.pumpScheduler()
  }

  private async pumpScheduler() {
    if (this.pumping || this.closing) return
    this.pumping = true
    try {
      while (this.pendingExecutions.length > 0) {
        const next = this.pendingExecutions[0]
        if (!next) break
        const claimed = await this.runs.claimAttempt(tenantId, next.manifest.attempt_id, runtimeId)
        if (!claimed) {
          const attempt = await this.runs.getAttempt(tenantId, next.manifest.attempt_id)
          if (attempt && attempt.status !== 'queued') {
            this.pendingExecutions.shift()
            continue
          }
          this.schedulePump()
          break
        }
        this.pendingExecutions.shift()
        void this.executeClaimed(next.run, next.manifest)
      }
    } finally {
      this.pumping = false
    }
  }

  private async executeClaimed(run: RunRecord, manifest: RuntimeManifest) {
    try {
      const handle = await this.runtime.execute(manifest)
      const unsubscribe = this.runtime.subscribe(run.id, (event) => this.queueEvent(run, event))
      await handle.done
      await this.eventWrites.get(run.id)
      unsubscribe()
    } catch (error) {
      const attempt = await this.runs.getAttempt(tenantId, manifest.attempt_id)
      const currentRun = await this.runs.getRun(tenantId, run.id)
      if (attempt && !['failed', 'cancelled', 'succeeded'].includes(attempt.status)) {
        await this.runs.transitionAttempt(tenantId, attempt.id, 'failed', 'RUNTIME_DISPATCH_FAILED')
      }
      if (currentRun && !['failed', 'cancelled', 'succeeded'].includes(currentRun.status)) {
        await this.runs.transitionRun(tenantId, run.id, 'failed')
      }
      console.error('runtime dispatch failed', error)
    } finally {
      if (!this.closing) void this.pumpScheduler()
    }
  }

  private schedulePump() {
    if (this.schedulerTimer || this.closing) return
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = undefined
      void this.pumpScheduler()
    }, 500)
    this.schedulerTimer.unref()
  }

  private queueEvent(run: RunRecord, event: RuntimeEvent) {
    const previous = this.eventWrites.get(run.id) ?? Promise.resolve()
    const next = previous.then(() => this.persistEvent(run, event)).catch((error: unknown) => {
      console.error('persist runtime event failed', error)
    })
    this.eventWrites.set(run.id, next)
  }

  private async persistEvent(run: RunRecord, event: RuntimeEvent) {
    const stored: StoredRunEvent = {
      id: event.event_id,
      tenantId,
      runId: event.run_id,
      attemptId: event.attempt_id,
      sequence: event.sequence,
      eventType: event.event_type,
      displayMessage: event.display_message,
      safeMetadata: JSON.parse(JSON.stringify(event.safe_metadata)) as JsonObject,
      traceId: event.trace_id,
      occurredAt: event.occurred_at,
    }
    await this.runs.appendEvent(stored)
    if (event.event_type === 'run.started') {
      await this.runs.transitionAttempt(tenantId, event.attempt_id, 'running')
      await this.runs.transitionRun(tenantId, run.id, 'running')
    } else if (event.event_type === 'assistant.completed' && event.display_message) {
      const assistantContent = this.knowledge
        ? await this.knowledge.addCitationFooter(event.attempt_id, event.display_message)
        : event.display_message
      this.assistantOutputs.set(event.attempt_id, assistantContent)
      await this.conversations.appendMessage({
        sessionId: run.sessionId,
        runId: run.id,
        role: 'assistant',
        content: assistantContent,
        messageId: `message-assistant-${event.event_id}`,
      })
    } else if (event.event_type === 'run.cancel_requested') {
      await this.transitionIfNeeded(run.id, event.attempt_id, 'cancel_requested')
    } else if (event.event_type === 'run.cancelled') {
      await this.transitionIfNeeded(run.id, event.attempt_id, 'cancelled')
    } else if (event.event_type === 'run.failed') {
      const code = typeof event.safe_metadata['error_code'] === 'string'
        ? event.safe_metadata['error_code']
        : 'RUNTIME_EXECUTION_FAILED'
      await this.runs.transitionAttempt(tenantId, event.attempt_id, 'failed', code)
      await this.runs.transitionRun(tenantId, run.id, 'failed')
      const attempt = await this.runs.getAttempt(tenantId, event.attempt_id)
      if (attempt) await this.operations?.recordModelUsage({
        run,
        attempt,
        prompt: await this.conversations.getRunPrompt(run.id),
        output: this.assistantOutputs.get(event.attempt_id) ?? '',
        status: 'failed',
        traceId: event.trace_id,
      })
      await this.operations?.appendAudit('system', 'run.failed', run.id, 'failed', event.trace_id, code)
    } else if (event.event_type === 'run.completed') {
      const attempt = await this.runs.getAttempt(tenantId, event.attempt_id)
      const assistantOutput = this.assistantOutputs.get(event.attempt_id) ?? ''
      await this.runs.transitionAttempt(tenantId, event.attempt_id, 'succeeded')
      await this.runs.transitionRun(tenantId, run.id, 'succeeded')
      if (attempt) await this.operations?.recordModelUsage({
        run,
        attempt,
        prompt: await this.conversations.getRunPrompt(run.id),
        output: assistantOutput,
        status: 'success',
        traceId: event.trace_id,
        inputTokens: typeof event.safe_metadata['input_tokens'] === 'number' ? event.safe_metadata['input_tokens'] : undefined,
        outputTokens: typeof event.safe_metadata['output_tokens'] === 'number' ? event.safe_metadata['output_tokens'] : undefined,
      })
      await this.operations?.appendAudit('system', 'run.completed', run.id, 'success', event.trace_id, 'DSH Runtime 执行完成')
      this.assistantOutputs.delete(event.attempt_id)
    } else if (event.event_type === 'approval.resolved') {
      const decision = event.safe_metadata['decision']
      await this.operations?.recordToolAudit({
        runId: run.id,
        attemptId: event.attempt_id,
        traceId: event.trace_id,
        metadata: event.safe_metadata,
        result: decision === 'allow_once' ? 'success' : 'blocked',
      })
    }
  }

  private async transitionIfNeeded(runId: string, attemptId: string, state: 'cancel_requested' | 'cancelled') {
    const attempt = await this.runs.getAttempt(tenantId, attemptId)
    const run = await this.runs.getRun(tenantId, runId)
    if (attempt && attempt.status !== state) await this.runs.transitionAttempt(tenantId, attemptId, state)
    if (run && run.status !== state) await this.runs.transitionRun(tenantId, runId, state)
  }

  private async requireOwnedRun(runId: string, userId: string) {
    const run = await this.runs.getRun(tenantId, runId)
    if (!run || run.requestedBy !== userId) throw new Error(`Run 不存在或不可访问：${runId}`)
    return run
  }
}

function assertPrompt(prompt: string) {
  const length = prompt.trim().length
  if (length < 1 || length > 20_000) throw new Error('消息长度必须为 1～20000 个字符')
}

function toCapabilityReference(reference: string) {
  const separator = reference.lastIndexOf('@')
  return separator > 0
    ? { id: reference.slice(0, separator), version: reference.slice(separator + 1) }
    : { id: reference, version: 'current' }
}
