# dsh-work 内部端口契约（M0 基线）

版本：V0.1
状态：待 M1 技术 POC 校验
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
  start(manifest: RuntimeManifest, signal?: AbortSignal): Promise<StartRunResult>
  cancel(runId: string, requestedBy: string): Promise<{ accepted: boolean }>
  getStatus(runId: string): Promise<RunStatus>
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
- 超时由调用端传入并受平台上限约束；取消通过 `AbortSignal` 和显式 `cancel` 双通道传播。
- 端口不得传递企业 SSO Cookie、模型密钥或连接器凭据；只传短期授权引用。
- 对员工展示的事件必须符合 `run-event.schema.json`，隐藏推理不得持久化或返回前端。

## 4. M1 必须验证的问题

1. deepseek-harness 是否提供稳定的嵌入/子进程接口来接收 Manifest，并输出结构化事件。
2. 取消是否能可靠终止模型流、工具调用和子进程，且不会遗留沙箱资源。
3. Runtime 崩溃后，事件序号和 Run 状态能否由控制面一致恢复。
4. Skill、工具描述与文件挂载能否以不可变版本进入执行环境。
5. 并发执行时，Session 上下文、工作目录和凭据引用是否严格隔离。

M1 若无法满足以上约束，应调整 Adapter 或隔离进程，不得让员工 BFF 直接依赖 DSH CLI 文本输出。
