# M1 DSH Runtime 技术 POC 记录

版本：V0.1
日期：2026-08-30
状态：第一阶段通过，M1 Gate 尚未关闭

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

dsh-work 的 Runtime Adapter 只启动固定版本的 `pnpm run demo:acp`，不注入 Provider、模型或 Base URL，也不把密钥写入 Manifest、日志或数据库。Agent 创建仍不提供模型策略。M1 POC 只发送合成数据；正式企业数据的模型出口、脱敏和合规规则属于 D-09。

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

## 6. M1 剩余项目

| 工作项 | 状态 | 下一条件 |
|---|---|---|
| M1-01 固定 DSH 版本 | 已完成 | 升级时重跑 POC |
| M1-02 Headless/程序化冒烟 | 部分完成 | ACP 无密钥探针通过；真实模型回答待本机配置 `DEEPSEEK_API_KEY` |
| M1-03 Runtime Adapter 骨架 | POC 已完成 | 接入服务端 Run Repository 后转正式实现 |
| M1-04 Manifest 编译 | POC 已完成 | M2 增加数据库 Agent/权限快照来源 |
| M1-05 Worker 生命周期 | POC 已完成 | 继续验证真实 DSH 崩溃和僵尸进程 |
| M1-06 标准事件转换 | 部分完成 | 增加 DSH Tool/usage observer 投影 |
| M1-07 取消、超时和重试 | 部分完成 | 真实模型/Tool 运行中取消；重试由 Run 编排创建新 Attempt |
| M1-08 模型链路 | 配置已确认、验证阻塞 | D-02 已确认继承 DSH 默认配置；当前缺少 `DEEPSEEK_API_KEY`，尚未执行真实请求 |
| M1-09 Tool 链路 | Mock 已完成 | D-05 至少一个真实只读 Tool |
| M1-10 文件与成果 | 未开始 | D-07 Artifact 存储决定 |
| M1-11 Mac mini 资源基线 | 未开始 | 真实模型链路可运行后测 1/3/5 并发 |
| M1-12 POC 决策评审 | 待完成 | M1-08 至 M1-11 有真实证据 |

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

当前不需要 Fork DSH。若 observer/telemetry 无法通过正式插件接口提供所需事件，再在 M1-12 比较最小 Fork、降低粒度或更换 Runtime。
