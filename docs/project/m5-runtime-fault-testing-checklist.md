# M5-03 运行故障测试验收清单

**状态：** 工程验收通过

**日期：** 2026-08-30

**范围：** DSH ACP Worker、Runtime Adapter、Run 编排、PostgreSQL 状态、SSE 断点续传和服务启动恢复。

## 故障矩阵

| 场景 | 预期行为 | 自动化证据 | 结果 |
|---|---|---|---|
| Worker 崩溃 | 当前 Attempt 收敛为 `RUNTIME_WORKER_CRASH`，不影响其他隔离执行，活动计数归零 | Runtime 子进程故障注入 | 通过 |
| 员工取消 | 传播 ACP Cancel，单一终态为 `cancelled` | Runtime 契约及 M3 PostgreSQL 回归 | 通过 |
| Attempt 超时 | 先请求取消，宽限期后强制回收，终态为 `RUN_TIMEOUT` | Runtime 契约 | 通过 |
| 模型失败 | 保留 `MODEL_INVOCATION_FAILED`，前端获得可重试说明 | ACP 分类 + PostgreSQL 投影 | 通过 |
| Tool 超时 | 保留 `TOOL_TIMEOUT`，不会误报模型或通用 Runtime 错误 | ACP 分类 + PostgreSQL 投影 | 通过 |
| 运行网络中断 | 保留 `NETWORK_UNAVAILABLE`，提示恢复网络后重试 | ACP 分类 + PostgreSQL 投影 | 通过 |
| SSE 断线重连 | 将 `Last-Event-ID` 作为游标，只返回其后的持久化事件，终态后关闭 | SSE 单元 + PostgreSQL 游标回归 | 通过 |
| 服务正常关闭 | 活动 Attempt 标记 `SERVICE_SHUTDOWN`，不伪装成员工取消；终态事件写完后再关数据库 | Runtime 契约 | 通过 |
| 服务异常重启 | 遗留运行中 Attempt 标记 `SERVICE_RESTARTED`；排队 Attempt 使用原 Manifest 恢复调度 | PostgreSQL 重启恢复回归 | 通过 |

## 恢复规则

- 运行中或正在取消的 Attempt 绑定旧 Worker，进程消失后不可安全续接，因此必须失败关闭并保留原 Attempt。
- 尚未开始的排队 Attempt 没有外部副作用，可以使用已持久化、不可变且带校验值的 Manifest 重新调度。
- 重试始终创建新 Attempt，不覆盖失败 Attempt；服务恢复本身不擅自重放已经开始执行的任务。
- SSE 游标基于 PostgreSQL `stream_position`，不依赖 Node.js 进程内事件缓存。
- Runtime 关闭后先等待终态事件落库，再关闭 PostgreSQL，避免状态写入竞态。

## 执行命令

```bash
pnpm verify:m5:faults
pnpm test:m1
pnpm test:m5:faults
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m5:faults:integration
pnpm ci:check
```

## 明确边界

- Worker、模型、Tool 和网络错误使用可重复的 ACP 故障注入验证平台行为；尚未在生产网络上进行真实断网、代理失效或模型 Provider 故障演练。
- R-15 已关闭，真实模型、Tool 和 Artifact 探针均已重跑通过；Mock 故障注入只用于可重复验证异常分支，不替代真实成功证据。
- 进程和单节点服务恢复已覆盖；主机掉电、PostgreSQL 故障、磁盘耗尽、备份恢复及多节点接管不在本项范围，分别进入 M5-05、M5-08。
- 本项只验证错误能被结构化记录和展示；生产日志聚合、告警通知与升级策略属于 M5-07。
- 本清单关闭 M5-03 工程 Gate，不等于预生产故障演练或试点 Go-Live 已通过。

## 结论

M5-03 工程 Gate 关闭。单机 MVP 对 Worker 崩溃、取消、超时、模型/Tool/网络失败、SSE 重连和服务重启建立了确定性终态、可重试语义和持久化恢复策略；真实外部依赖和主机级演练继续作为部署与试点前置条件。
