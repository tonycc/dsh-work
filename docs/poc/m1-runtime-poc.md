# M1 DSH Runtime 技术 POC 记录

版本：V0.2
日期：2026-08-30
状态：M1 Gate 已关闭

## 1. POC 结论

Runtime Adapter 采用 DSH 的 ACP JSON-RPC stdio 接口，不采用 `dsh --profile headless` 的 stdout 作为产品运行协议。

原因：

- Headless 产品命令适合人工或诊断调用，只打印最终 assistant 文本；
- Headless 测试中的 JSONL Driver 是未导出的测试基础设施，不是稳定产品接口；
- DSH ACP 是明确面向程序化客户端的接口，支持 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` 和一次性权限请求；
- ACP stdout 只承载 JSON-RPC，适合由每 Attempt 独立子进程托管。

## 2. 固定的 DSH 基线

| 项目 | 基线 |
|---|---|
| 本地仓库 | `/Users/max/projects/deepseek-harness` |
| 版本 | `0.1.1-rc.2` |
| Commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| License | MIT |
| Node.js 要求 | `^22.19.0 || >=24.0.0` |
| ACP 启动 | `pnpm run demo:acp` |
| 诊断 Headless | `pnpm dsh --profile headless "task"` |
| 回滚基线 | 上述固定 Commit；升级必须先通过同一套 POC |

DSH 仓库存在未跟踪的 `scratch-plugin/`，不属于本次运行闭包，也不得作为 dsh-work 依赖。

## 3. 已实现 POC

代码位置：`server/src/modules/runtime`。

- `AcpJsonRpcClient`：启动真实子进程、NDJSON JSON-RPC、请求关联、Session Update、权限请求、取消和进程回收；
- `DshAcpRuntimeAdapter`：实现 `execute/subscribe/cancel/status/close/health`；
- `compileRuntimeManifest`：校验执行输入、生成稳定 canonical JSON 和 SHA-256；
- 每个 Attempt 独立目录：`tenant/run/attempt/{manifest.json,workspace,output,sessions}`；
- 标准安全事件：排队、启动、assistant 提交块、权限请求/结果、取消、超时、失败和完成；
- 默认权限为 fail-closed，没有上层决策器时拒绝一次性权限；
- 用户取消和超时先发送 ACP `session/cancel`，宽限期后强制回收子进程；
- 错误进入员工事件前截断并脱敏，DSH stderr 不进入员工 Run Event。

### 3.1 M1 模型配置基线

M1 不在 dsh-work 中建立一套平行的模型配置，而是由启动的 DSH ACP 组合解析当前默认模型配置：

| 项目 | 当前 DSH 默认值 |
|---|---|
| Provider | `deepseek-official` |
| 模型 | `deepseek-v4-pro` |
| Base URL | 未设置 `DEEPSEEK_BASE_URL` 时使用 `https://api.deepseek.com` |
| Thinking | 开启 |
| Reasoning effort | `max` |
| Context window | `1,000,000` Token |
| 单次输出上限 | `256,000` Token |
| 凭据引用 | `DEEPSEEK_API_KEY`，只由 DSH 的凭据层或进程环境解析 |

dsh-work 的 Runtime Adapter 通过 `server/config/dsh/acp-managed-credentials.cordis.yml` 包装固定版本的 ACP 示例组合，仅补充 DSH 自己的 Settings 和 Credentials Provider；它不注入 Provider、模型、Base URL 或 API Key，也不把密钥写入 Manifest、日志或数据库。Agent 创建仍不提供模型策略。M1 POC 只发送合成数据；正式企业数据的模型出口、脱敏和合规规则属于 D-09。

## 4. 验证证据

### 4.1 自动化测试

命令：

```bash
pnpm test:m1
```

已通过 6 项：

1. Manifest 对象键顺序不影响 SHA-256；
2. 非 `/workspace/input/` 的输入挂载被拒绝；
3. 完成链路产生连续、可重放的标准事件；
4. ACP 权限请求默认拒绝并产生审计事件；
5. 运行中取消到达单一 `cancelled` 终态；
6. 超时产生 `RUN_TIMEOUT`，并发 Attempt 目录互相隔离。

### 4.2 真实 DSH 无密钥探针

命令：

```bash
pnpm probe:m1
```

2026-08-30 结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","protocolVersion":1,"sessionCreated":true,"transport":"acp-stdio","realModelPromptExecuted":false}
```

该探针启动真实本地 DSH ACP 进程并完成协议协商、Session 创建和取消通知。它使用占位启动密钥，但没有执行 `session/prompt`，因此不会发起外部模型请求。

### 4.3 真实模型探针

命令：

```bash
pnpm probe:m1:real
```

该探针通过相同 ACP 程序化入口发送一条纯合成提示。部署 Overlay 为上游 ACP 示例挂载 DSH 的 Settings 和 Credentials Provider；探针不向子进程注入模型、Base URL 或 API Key，因此由 DSH 当前默认配置及受管凭据层完成解析。探针只输出协议版本、是否收到回答、回答字节数和停止原因，不输出回答正文或凭据。该命令不属于 CI，只有人工执行时才产生一次真实模型调用。

2026-08-30 真实调用结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","protocolVersion":1,"transport":"acp-stdio","modelConfiguration":"dsh-default","probeMode":"model","realModelPromptExecuted":true,"realReadOnlyToolVerified":false,"tokenUsageRecorded":true,"inputTokens":6111,"outputTokens":40,"toolCallCount":0,"toolResultCount":0,"assistantTextReceived":true,"assistantResponseBytes":17,"stopReason":"end_turn","diagnosticCount":0}
```

DSH 的受管凭据位于 DSH 自己的 Credentials Provider 中。dsh-work 仅挂载该 Provider，不读取、复制或输出密钥。

### 4.4 真实只读 Tool 探针

命令：

```bash
pnpm probe:m1:tool
```

探针在隔离工作区创建一个只存在于文件中的合成标记，要求默认模型使用 DSH 文件读取工具读取并返回该标记。只有回答包含该标记才判定通过；输出仍不包含回答正文。该验证证明模型、真实只读 Tool、工具结果和最终回答形成闭环。Tool 过程和审计事件仍需 M1-06 的正式观测投影。

2026-08-30 真实 Tool 调用结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","protocolVersion":1,"transport":"acp-stdio","modelConfiguration":"dsh-default","probeMode":"read-only-tool","realModelPromptExecuted":true,"realReadOnlyToolVerified":true,"tokenUsageRecorded":true,"inputTokens":6111,"outputTokens":78,"toolCallCount":1,"toolResultCount":1,"assistantTextReceived":true,"assistantResponseBytes":22,"stopReason":"end_turn","diagnosticCount":0}
```

Token 和 Tool 计数来自 DSH 权威 Session Log，不来自模型文本或 ACP 推断。生产侧仍应通过带脱敏规则的 Session Telemetry 投影到 dsh-work；不能直接启用无脱敏的 FULL OTel 导出，因为它会携带提示、工具参数和结果正文。

### 4.5 文件与成果探针

命令：

```bash
pnpm probe:m1:artifact
```

探针创建只读 `input/source.txt` 和受控 `output/`，要求 DSH 读取输入并生成 `output/report.md`。验收同时检查输入未改变、成果包含只存在于输入中的合成标记，并记录成果字节数和 SHA-256；只有 `output/` 下的文件进入成果收集范围。

2026-08-30 结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","protocolVersion":1,"transport":"acp-stdio","modelConfiguration":"dsh-default","probeMode":"artifact","realModelPromptExecuted":true,"realReadOnlyToolVerified":true,"tokenUsageRecorded":true,"inputTokens":6328,"outputTokens":241,"toolCallCount":2,"toolResultCount":2,"artifactVerified":true,"artifactBytes":41,"artifactSha256":"43ad4dc01b61c3d60f21ffae8f91c4913fcdff60296b4127f8bd18a6aea4c1f9","assistantTextReceived":true,"assistantResponseBytes":15,"stopReason":"end_turn","diagnosticCount":0}
```

### 4.6 真实取消探针

命令：

```bash
pnpm probe:m1:cancel
```

探针启动真实模型请求，随后通过 ACP `session/cancel` 取消，并要求在 30 秒内以 `cancelled` 停止原因收敛。它不输出任何中间回答。

2026-08-30 结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","protocolVersion":1,"transport":"acp-stdio","realModelCancellationVerified":true,"stopReason":"cancelled","settleMs":255,"diagnosticCount":0}
```

### 4.7 真实并发资源探针

命令：

```bash
pnpm probe:m1:concurrency
```

探针依次运行 1、3、5 个真实 ACP Worker，每个 Worker 使用独立 Session 和工作目录。它记录批次成功数、墙钟耗时及 ACP Worker 根进程和全部后代进程的峰值 RSS，不输出回答正文。

2026-08-30 结果：

```json
{"ok":true,"dshVersion":"0.1.1-rc.2","transport":"acp-stdio","modelConfiguration":"dsh-default","batches":[{"concurrency":1,"succeeded":1,"elapsedMs":2531,"peakWorkerTreeRssMiB":167,"diagnosticCount":0},{"concurrency":3,"succeeded":3,"elapsedMs":2193,"peakWorkerTreeRssMiB":492,"diagnosticCount":0},{"concurrency":5,"succeeded":5,"elapsedMs":2550,"peakWorkerTreeRssMiB":829,"diagnosticCount":0}]}
```

## 5. 已确认的接口限制

DSH ACP 当前只发送已经提交的 assistant 消息块，明确不在 ACP 线上提供：

- Token 级原始增量；
- reasoning/隐藏推理；
- Tool 调用过程；
- 用量和模型路由明细；
- Session 恢复、列表、删除和单 Session close。

因此：

- dsh-work 可立即用 ACP 完成 Session、最终回答、取消与权限通道；
- `assistant.delta` 在当前 POC 中表示“已提交消息块”，不是未提交 Token 流；
- Tool、Token、模型延迟和更细粒度步骤事件需要 DSH observer/telemetry 插件投影，不能从 ACP stdout 猜测；
- 不能使用 DSH 测试专用 JSONL Driver 规避这一边界。

## 6. M1 工作项结论

| 工作项 | 状态 | 下一条件 |
|---|---|---|
| M1-01 固定 DSH 版本 | 已完成 | 升级时重跑 POC |
| M1-02 Headless/程序化冒烟 | 已完成 | ACP 无密钥协议探针和受管凭据真实模型探针均通过 |
| M1-03 Runtime Adapter 骨架 | POC 已完成 | 接入服务端 Run Repository 后转正式实现 |
| M1-04 Manifest 编译 | POC 已完成 | M2 增加数据库 Agent/权限快照来源 |
| M1-05 Worker 生命周期 | POC 已完成 | 继续验证真实 DSH 崩溃和僵尸进程 |
| M1-06 标准事件转换 | POC 已完成 | ACP 安全事件及权威日志 Tool/usage 已验证；M3 增加带脱敏规则的实时 Telemetry 投影 |
| M1-07 取消、超时和重试 | POC 已完成 | Mock 超时与真实模型 ACP 取消均通过；重试由 Run 编排创建新 Attempt |
| M1-08 模型链路 | 主链路完成 | D-02 已确认；真实默认模型返回 `end_turn`，Token/延迟投影仍归 M1-06 |
| M1-09 Tool 链路 | POC 已完成 | DSH 文件读取 Tool 真实闭环及权威日志审计已通过；企业 Connector 属后续阶段 |
| M1-10 文件与成果 | POC 已完成 | 隔离输入、受控输出、内容校验和 SHA-256 已通过；MVP 持久存储仍待 D-07 |
| M1-11 Mac mini 资源基线 | POC 已完成 | 1/3/5 全部成功，峰值 Worker 进程树 RSS 为 167/492/829 MiB |
| M1-12 POC 决策评审 | 已完成 | M1 Gate 关闭；不 Fork DSH，正式观测使用 Session Telemetry 脱敏投影 |

## 7. 当前架构决策

```text
dsh-work Run 编排
  → Runtime Manifest
  → 每 Attempt 独立 DSH ACP 子进程
  → ACP Session / Prompt / Cancel / Permission
  → Runtime Adapter 标准 Run Event
  → Event Store / SSE（M2-M3 实现）

DSH observer/telemetry（待实现）
  → Tool、Token、模型延迟和安全审计事件
```

最终决定不 Fork DSH。ACP 承担安全控制与已提交回答，DSH 权威 Session Log 提供完整审计事实，官方 Session Telemetry 扩展点承担后续实时投影。dsh-work 必须在 FULL Telemetry 出口前实现显式脱敏规则，只投影允许的 Tool、Token、时延和状态字段。

M3 完成后补充交付决策：本地开发可继续使用经过版本与 Commit 校验的源码 checkout；integration、staging 和 pilot 使用独立受管 Runtime 制品。服务端在监听端口前完成安装元数据校验和 ACP `initialize` 预检。详见 `docs/deployment/dsh-runtime-delivery.md`。
