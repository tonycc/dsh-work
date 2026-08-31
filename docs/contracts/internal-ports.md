# dsh-work 内部端口契约

版本：V0.2
状态：M1 ACP、真实模型、Tool、Token、Artifact、取消和并发 POC 已校验；正式 Repository、SSE 和 Telemetry 投影在后续阶段实现
原则：两个前端只调用各自 BFF；控制面通过端口访问 Runtime、模型、工具、成果和治理能力。

## 1. 端口总览

| 端口 | 调用方 | 实现方 | 一期职责 | 失败语义 |
|---|---|---|---|---|
| `AgentRuntimePort` | Run 编排服务 | DSH Runtime Adapter | 启动、取消、查询一次 Run Attempt | 明确区分拒绝、超时、取消、Runtime 故障 |
| `RunEventStorePort` | Runtime Adapter、Run 编排服务 | PostgreSQL 事件存储 | 顺序追加、断点读取安全事件 | 同一 `event_id` 幂等；序号冲突拒绝 |
| `ModelGatewayPort` | Runtime Adapter | 企业模型网关 | 路由、限流、Token 与费用计量 | 不向上游暴露模型密钥 |
| `SecretStorePort` | 模型治理服务、Model Gateway | DSH Credentials Provider；未来为系统钥匙串或企业 Secret Manager | 写入、撤销和检查密钥引用对应的密钥 | 业务数据库、日志和 API 均不得出现密钥正文 |
| `ToolGatewayPort` | Runtime Adapter | 企业 Tool/Connector Gateway | 调用一期平台预置工具和连接器 | 鉴权、审批、超时和业务错误分离 |
| `ArtifactServicePort` | Runtime Adapter、员工 BFF | 文件与成果服务 | 创建成果版本、鉴权下载 | 成果不可覆盖，只能新增版本 |
| `GovernancePort` | 员工 BFF、管理 BFF、编排服务 | 当前 dsh-work 控制面；未来可迁移 AI Hub | Agent、Skill、权限、数据范围快照 | 版本不存在或不可见时拒绝执行 |

## 2. TypeScript 逻辑接口

以下接口用于冻结语义，不要求 M1 按文件原样复制。

```ts
type StartRunResult = {
  runId: string
  attemptId: string
  acceptedAt: string
}

interface AgentRuntimePort {
  execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle>
  subscribe(runId: string, listener: RuntimeEventListener): () => void
  cancel(runId: string, requestedBy: string): Promise<{ accepted: boolean }>
  status(runId: string): RuntimeExecutionSnapshot | undefined
  health(): Promise<RuntimeHealth>
  close(): Promise<void>
}

interface RunEventStorePort {
  append(event: RunEvent): Promise<void>
  read(runId: string, afterSequence?: number): AsyncIterable<RunEvent>
}

interface ModelGatewayPort {
  resolveRoute(context: ModelRouteContext): Promise<ModelRoute>
  recordUsage(usage: TokenUsage): Promise<void>
}

interface SecretStorePort {
  put(reference: string, secret: string): Promise<void>
  remove(reference: string): Promise<void>
  exists(reference: string): Promise<boolean>
}

interface ToolGatewayPort {
  describe(toolId: string, version: string): Promise<ToolDescriptor>
  invoke(request: ToolInvocation, signal?: AbortSignal): Promise<ToolResult>
}

interface ArtifactServicePort {
  createVersion(input: ArtifactVersionInput): Promise<ArtifactVersion>
  authorizeDownload(userId: string, versionId: string): Promise<DownloadGrant>
}

interface GovernancePort {
  getAgentVersion(agentVersionId: string): Promise<AgentVersionSnapshot>
  resolveCapabilities(input: CapabilityContext): Promise<CapabilitySnapshot>
  authorizeDataScopes(input: DataScopeRequest): Promise<DataScopeDecision>
}
```

## 3. 共同约束

- `run_id` 表示用户可感知的一次运行；重试创建新的 `attempt_id`，不得覆盖原 Attempt。
- `RuntimeManifest` 在执行开始后不可变，Agent 后续修改不影响已启动 Run。
- 开始 Run 必须带 `idempotencyKey`；相同员工、Session 和键只能产生一个 Run。
- 调用链全程携带 `trace_id`，审计记录主体、动作、对象、结果和请求来源。
- 超时由 Manifest 传入并受平台上限约束；取消先通过 ACP `session/cancel` 传播，宽限期后回收 Attempt 子进程。
- 端口不得传递企业 SSO Cookie、模型密钥或连接器凭据；只传短期授权引用。
- Provider、模型和路由由 dsh-work 治理；Agent 不保存模型策略。路由在创建 Attempt 前解析，并作为不含密钥正文的不可变快照持久化。
- 当前 `dsh-managed` SecretStore 适配器只登记并检查引用，不读取、复制或覆盖 DSH 的现有密钥；切换密钥后端不改变模型治理业务表。
- DSH ACP 子进程只继承显式 OS/DSH 基线环境；数据库连接、应用 Secret、Token 和连接器凭据不得通过父进程环境透传，敏感覆盖请求必须失败关闭。
- 管理审计、授权记录、Runtime 诊断和 Tool 参数摘要在持久化前统一递归脱敏，读取时再次执行防御性脱敏；Token 数量等非凭据指标可以保留。
- Worker 崩溃、模型失败、Tool 超时、网络中断和服务停止必须保留独立错误码；不得全部折叠为通用失败或员工取消。
- 服务启动时，旧进程遗留的运行中 Attempt 以 `SERVICE_RESTARTED` 失败关闭；只有尚未开始的排队 Attempt 可以使用原不可变 Manifest 恢复调度。
- SSE 重连只依赖 PostgreSQL 全 Run `stream_position` 和 `Last-Event-ID`，不得依赖进程内事件缓存。
- 对员工展示的事件必须符合 `run-event.schema.json`，隐藏推理不得持久化或返回前端。

## 4. M1 验证结果

| 问题 | 当前结论 |
|---|---|
| 稳定程序化接口 | 采用 DSH ACP JSON-RPC stdio；Headless CLI 最终文本不作为产品协议 |
| 结构化事件 | ACP 支持提交后的 assistant 消息、取消和权限；Tool、Token 与原始增量需要 observer/telemetry 投影 |
| 取消与超时 | Mock 超时和真实模型 ACP 取消均通过；真实取消约 255ms 收敛为 `cancelled` |
| 进程与目录隔离 | 每 Attempt 独立进程和目录的并发测试通过 |
| Manifest | canonical JSON、SHA-256 和 Attempt 快照已实现 |
| 崩溃恢复 | Adapter 可形成失败终态；PostgreSQL 事件恢复在 M2-M3 实现 |
| Skill、Tool、文件 | 版本引用进入 Manifest；真实挂载和调用仍待 M1 后续验证 |

员工 BFF 不得直接依赖 DSH CLI、ACP 或 DSH Session；所有调用继续经过 `AgentRuntimePort`。
