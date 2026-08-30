# M2 退出检查表

更新时间：2026-08-30  
当前结论：M2 平台基础能力工程 Gate 已关闭，可进入使用合成数据的 M3 端到端垂直闭环。企业 SSO、数据分级、Artifact 存储和部署参数仍是上线前外部决策，不被硬编码进 M2 物理模型。

| 退出条件 | 状态 | 证据/说明 |
|---|---|---|
| 服务端保持模块化单体 | 已满足 | `server/src/modules` 按 admin、workbench、runtime、model、run 划分；没有拆业务微服务 |
| PostgreSQL 连接池和显式迁移 | 已满足 | `postgres.js`、`server/migrations/0001_m2_platform.sql`、`0002_m2_seed.sql`；迁移重复执行会跳过 |
| 全量物理表与租户约束 | 已满足 | 身份、治理、工作空间、Session、Run、文件、成果、审计、Runtime、Provider 共 30+ 表；关键外键包含 `tenant_id` |
| 治理版本不可变 | 已满足 | PostgreSQL Trigger 拒绝修改/删除已发布 Agent Version 和 Skill Version；集成测试通过 |
| Run 创建幂等 | 已满足 | `unique(tenant_id, session_id, requested_by, idempotency_key)`；Repository 重复创建返回原 Run |
| Run/Attempt 状态机 | 已满足 | 普通终态不可回退；只有显式失败重试可原子创建递增的新 Attempt 并重新排队，原 Attempt 不变 |
| Run Event 可顺序追加与幂等 | 已满足 | Event ID 幂等；同 Attempt 序号冲突由唯一约束拒绝；M3 再落实 SSE `Last-Event-ID` |
| Provider、模型与路由治理 | 已满足 | 管理 API 和 `/model-governance` 页面；默认 DSH Provider/模型种子；默认路由租户内唯一 |
| 密钥不进入业务存储 | 已满足 | 数据库/API 只存 `credential_ref`；当前引用 DSH `DEEPSEEK_API_KEY`；集成测试确认响应/快照无 `secret` 字段 |
| Attempt 模型快照 | 已满足 | `run_attempts.model_route_snapshot` 持久化 Provider、模型、地址和凭据引用，不含密钥正文 |
| 真实 PostgreSQL 集成测试 | 已满足 | PostgreSQL 17 临时容器中 5/5 通过：迁移、租户隔离、幂等、重试、事件、不可变版本、路由解析 |
| 管理与员工 API 全面替换 Prototype Repository | 分阶段满足 | M2 新增 Run/Model PostgreSQL Repository；现有原型查询仍保留演示适配器，M3 按垂直链路替换，不双写 |
| 企业 SSO 与真实授权 | 批准延期 | D-03 待选型；表和两个 API Audience 已预留，M3 合成数据不受阻，真实用户试点受阻 |
| Artifact 物理存储 | 批准延期 | D-07 待确定本地目录或 NAS；表只保存 `storage_key`，不写死路径 |

## 实测命令

```bash
pnpm typecheck
pnpm test:m2
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m2:integration
pnpm ci:check
```

M3 必须使用 `PostgresRunRepository` 创建真实 Session/Run/Attempt，解析平台默认模型路由并写入 Attempt 快照；不得让员工 BFF 直接读取 DSH 配置或模型密钥。
