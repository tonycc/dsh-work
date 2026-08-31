export type RuntimeRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RuntimeEventType =
  | 'run.queued'
  | 'run.started'
  | 'assistant.delta'
  | 'assistant.completed'
  | 'approval.required'
  | 'approval.resolved'
  | 'run.cancel_requested'
  | 'run.cancelled'
  | 'run.failed'
  | 'run.completed'

export interface RuntimeManifest {
  manifest_version: '1.0'
  run_id: string
  attempt_id: string
  session_id: string
  workspace_id: string
  agent_version_id: string | null
  agent_configuration: {
    system_prompt: string
    skill_instructions: Array<{
      id: string
      version: string
      instructions: string
    }>
  }
  user_context: {
    user_id: string
    tenant_id: string
    role_ids: string[]
  }
  permission_policy: {
    approval_mode: 'always' | 'risk_based' | 'never'
    network_policy: 'deny' | 'allowlist'
    write_policy: 'deny' | 'workspace_only' | 'approved_targets'
  }
  skills: CapabilityReference[]
  tools: CapabilityReference[]
  data_scopes: string[]
  knowledge_context: RuntimeKnowledgeDocument[]
  model_route_id?: string | null
  input: {
    message: string
    file_mounts: FileMount[]
  }
  limits: {
    timeout_seconds: number
    max_output_bytes: number
    max_tool_calls: number
  }
  created_at: string
  trace_id?: string
}

export interface RuntimeKnowledgeDocument {
  documentId: string
  title: string
  version: string
  effectiveDate: string
  dataScope: string
  contentChecksum: string
  excerpt: string
}

export interface CapabilityReference {
  id: string
  version: string
}

export interface FileMount {
  file_id: string
  mount_path: string
  access: 'read_only'
  source_name: string
  media_type: string
  content_sha256: string
  content: string
}

export interface CompiledRuntimeManifest {
  manifest: RuntimeManifest
  canonicalJson: string
  sha256: string
}

export interface RuntimeEvent {
  event_id: string
  run_id: string
  attempt_id: string
  sequence: number
  event_type: RuntimeEventType
  occurred_at: string
  display_message: string | null
  safe_metadata: Record<string, unknown>
  trace_id: string
  parent_event_id: string | null
}

export interface RuntimeExecutionSnapshot {
  runId: string
  attemptId: string
  status: RuntimeRunStatus
  acceptedAt: string
  startedAt: string | null
  endedAt: string | null
  manifestSha256: string
  attemptDirectory: string
  errorCode: string | null
  errorMessage: string | null
}

export interface RuntimeExecutionHandle {
  runId: string
  attemptId: string
  acceptedAt: string
  done: Promise<RuntimeExecutionSnapshot>
}

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'offline'
  runtimeId: string
  activeExecutions: number
  acceptingRuns: boolean
  dshRepository: string
  runtimeVersion?: string
  runtimeCommit?: string
  protocolVersion?: number
  launchMode?: 'source-checkout' | 'managed-distribution'
  transport: 'acp-stdio'
  message: string
}

export type RuntimeEventListener = (event: RuntimeEvent) => void

export interface AgentRuntimePort {
  /** Execute a manifest that the durable scheduler has already admitted. */
  execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle>
  subscribe(runId: string, listener: RuntimeEventListener): () => void
  cancel(runId: string, requestedBy: string): Promise<{ accepted: boolean }>
  status(runId: string): RuntimeExecutionSnapshot | undefined
  health(): Promise<RuntimeHealth>
  /** Mirror scheduler state for health reporting; admission remains database-owned. */
  configureScheduling?(status: 'accepting' | 'draining' | 'disabled'): Promise<void>
  close(): Promise<void>
}
