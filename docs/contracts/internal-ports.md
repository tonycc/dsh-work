# dsh-work 内部端口契约

版本：V0.2
状态：M1 第一阶段 POC 已校验；真实模型、Tool 和 Artifact 仍待验证
原则：两个前端只调用各自 BFF；控制面通过端口访问 Runtime、模型、工具、成果和治理能力。

## 1. 端口总览

| 端口 | 调用方 | 实现方 | 一期职责 | 失败语义 |
|---|---|---|---|---|
| `AgentRuntimePort` | Run 编排服务 | DSH Runtime Adapter | 启动、取消、查询一次 Run Attempt | 明确区分拒绝、超时、取消、Runtime 故障 |
| `RunEventStorePort` | Runtime Adapter、Run 编排服务 | PostgreSQL 事件存储 | 顺序追加、断点读取安全事件 | 同一 `event_id` 幂等；序号冲突拒绝 |
| `ModelGatewayPort` | Runtime Adapter | 企业模型网关 | 路由、限流、Token 与费用计量 | 不向上游暴露模型密钥 |
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
- 对员工展示的事件必须符合 `run-event.schema.json`，隐藏推理不得持久化或返回前端。

## 4. M1 验证结果

| 问题 | 当前结论 |
|---|---|
| 稳定程序化接口 | 采用 DSH ACP JSON-RPC stdio；Headless CLI 最终文本不作为产品协议 |
| 结构化事件 | ACP 支持提交后的 assistant 消息、取消和权限；Tool、Token 与原始增量需要 observer/telemetry 投影 |
| 取消与超时 | Mock ACP 自动化测试通过；真实模型和真实 Tool 运行中验证待 D-02/D-05 |
| 进程与目录隔离 | 每 Attempt 独立进程和目录的并发测试通过 |
| Manifest | canonical JSON、SHA-256 和 Attempt 快照已实现 |
| 崩溃恢复 | Adapter 可形成失败终态；PostgreSQL 事件恢复在 M2-M3 实现 |
| Skill、Tool、文件 | 版本引用进入 Manifest；真实挂载和调用仍待 M1 后续验证 |

员工 BFF 不得直接依赖 DSH CLI、ACP 或 DSH Session；所有调用继续经过 `AgentRuntimePort`。
