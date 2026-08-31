# M4-07 Runtime 运维配置退出检查

**验证日期：** 2026-08-30

**工程结论：** M4-07 的 Runtime 最大并发、Attempt 超时、接收任务/排空/停用、健康检查和配置历史已经接入真实 PostgreSQL 调度与 DSH Adapter。该结论关闭单机 MVP 工程基线，不代表生产监控、容量和高可用验收已经完成。

| 验收项 | 结论 | 验收证据 |
|---|---|---|
| Runtime 独立配置 | 已完成 | `runtime_configurations` 按 `tenant_id + runtime_id + revision` 保存不可覆盖历史 |
| 最大并发 | 已完成 | Attempt 抢占在 PostgreSQL 锁内读取 Runtime `capacity`，超过容量保持排队 |
| 并发下调保护 | 已完成 | 新容量小于当前运行 Attempt 数时服务端拒绝，并说明当前活动 Worker 数 |
| Runtime 超时 | 已完成 | 最新 Runtime 超时作为硬上限进入 Manifest；与 Agent 超时取较短值，Adapter 据此终止超时 Attempt |
| 接收任务 | 已完成 | 数据库调度状态为 `accepting`，同时开启 Adapter 新执行入口 |
| 排空 | 已完成 | 切换 `draining` 后不再抢占新 Attempt，已运行 Attempt 不被强制终止 |
| 停用 | 已完成 | 切换 `disabled` 后数据库和 Adapter 都拒绝新执行，已运行 Attempt 不被强制终止 |
| 重启恢复 | 已完成 | 服务启动时读取最新持久化调度状态并应用到 Adapter，避免数据库与进程状态漂移 |
| 健康检查 | 已完成 | 检查真实 Adapter 安装与 ACP 可用状态，回写健康、版本和心跳 |
| 管理权限 | 已完成 | 健康检查和配置更新要求有效平台管理员角色；普通员工调用默认拒绝 |
| 配置校验 | 已完成 | 并发 1～128、超时 1～60 分钟、调度状态枚举均由服务端校验 |
| 审计 | 已完成 | 健康检查和每次配置变更写入操作者、Runtime、结果及安全摘要 |
| 自动化验证 | 已完成 | Adapter 单元测试覆盖三种调度状态；PostgreSQL 测试覆盖管理员、超时清单、容量、排空、恢复、停用、健康和历史 |

## 状态语义

```text
accepting ──► draining ──► disabled
    ▲             │            │
    └─────────────┴────────────┘

accepting：允许抢占和启动新 Attempt
draining：不抢占新 Attempt，等待当前执行自然结束
disabled：停用调度；不强制中断已经运行的 Attempt
```

排空和停用都不会取消当前执行。需要取消某个 Run 时，必须使用 Run 取消命令，避免运维配置产生隐式业务中断。

## MVP 边界

- 当前只有一个本机 `runtime-local-01`，并发限制通过 PostgreSQL 原子抢占实现；生产多节点需要租约、心跳过期、失联回收和跨节点调度。
- CPU、内存和磁盘当前仍是主机监控占位信息；M5-07 才接入指标采集、阈值和告警。
- 健康检查同时展示 Adapter/DSH 安装、调度状态和最近 24 小时真实 Attempt 质量；真实模型、Tool 和 Artifact 探针仍作为独立发布证据保留。
- 调度配置不会修改 Agent、Skill、Tool 或数据权限，也不会把 Provider 密钥复制到 dsh-work。
- Runtime 配置使用种子管理员请求字段是 D-03 未关闭前的工程入口；接入真实认证后改由服务端认证上下文提供操作者。

## 复验命令

```bash
pnpm verify:m4:runtime
pnpm test:m1
pnpm ci:check

# 需要一个已迁移或空的测试 PostgreSQL 数据库
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m4:runtime:integration
```
