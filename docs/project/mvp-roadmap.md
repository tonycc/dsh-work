# dsh-work MVP 路线图与交付状态

**状态日期：** 2026-09-01<br>
**当前结论：** 工程主链路已完成，处于外部依赖联调与试点准备阶段；尚不具备生产发布条件<br>
**执行模式：** 个人项目由项目 Owner 统一承担产品、研发、测试、安全与运维责任

本文只维护当前里程碑结论、开放 Gate 和下一步。各阶段的详细验收证据保留在同目录检查表中，已关闭任务不再在本文重复追加实施流水账。

## 1. 里程碑总览

| 里程碑 | 状态 | 日期/范围 | 主要证据 |
|---|---|---|---|
| M0 实施基线冻结 | 已关闭 | 2026-08-29 | 原型、契约、数据、测试数据、决策和 CI 基线 |
| M1 Runtime 技术 POC | 已关闭 | 2026-08-30 | 固定 DSH 版本，ACP stdio、模型、只读 Tool、成果、取消与并发探针通过 |
| M2 平台基础能力 | 已关闭 | 2026-08-30 | PostgreSQL、迁移、Run 状态机、模型治理和 Repository |
| M3 端到端垂直闭环 | 已关闭 | 2026-08-30 | Session/Run、DSH、SSE、文件、成果、审计和管理运行视图 |
| M4 MVP 功能完成 | 工程 Gate 已关闭 | 2026-08-30 | M4-01～M4-09 代码、契约和 PostgreSQL 验证完成；企业联调仍开放 |
| M5 上线准备 | 部分关闭 | 2026-08-30 起 | M5-01～M5-04 已关闭；部署、Secret/网络、监控、备份恢复和发布仍待完成 |
| M6 业务验收与试点启动 | 进行中 | 2026-09-01 起 | AI Hub 身份接入与应用自主授权代码完成；平台配置、UAT、试点数据、培训和 Go/No-Go 待完成 |
| M7 部门试点 | 未开始 | M6 通过后 2～4 周 | 真实价值、稳定性和安全指标 |

里程碑的“工程 Gate 已关闭”只代表约定范围内的实现和自动化证据成立，不等于真实业务试点准入通过，也不等于生产安全、运维或业务验收已经签署。

## 2. 已完成工程范围

### 2.1 Runtime 与平台基础

- 固定 DSH `0.1.1-rc.2` / Commit，使用 ACP JSON-RPC stdio 作为程序化协议；
- 一个 Attempt 一个隔离 DSH Worker、目录和不可变 Manifest；
- PostgreSQL 显式迁移、Run/Attempt 状态机、幂等创建、事件顺序和重启恢复；
- 模型路由快照、凭据引用、Tool Allowlist、取消、超时和错误分类；
- SSE 先落库后发送，支持 `Last-Event-ID` 断点续传。

### 2.2 M4 功能范围

| 工作项 | 工程结论 | 保留边界 |
|---|---|---|
| M4-01 Agent 管理 | 创建、测试、发布、停用、版本和回滚完成 | 真实业务效果评测待试点 |
| M4-02 Skill 管理 | 自动标识、测试门禁、版本和精确引用完成 | 跨应用治理后续可迁入 AI Hub |
| M4-03 预置 Tool/Connector | 本地只读 Tool、Schema、授权、健康和审计完成 | D-05 企业只读 Connector 待联调 |
| M4-04 企业知识查询 | 合成版本化知识、权限过滤、来源快照与引用完成 | D-06 真实知识源待联调 |
| M4-05 文件分析 | PDF/DOCX/XLSX/CSV/TXT/Markdown 基础解析与追溯完成 | OCR、复杂版面、企业扫描和正式存储待定 |
| M4-06 权限与数据范围 | 服务端角色、Workspace、Agent、Skill、Tool 与数据范围强制校验完成 | 真实账号和企业权限仍需 UAT |
| M4-07 Runtime 运维配置 | 容量、超时、排空/停用、健康和配置历史完成 | 主机级监控和多节点租约不在 MVP 工程范围 |
| M4-08 审计与运营 | 六类运营事件、筛选、脱敏导出和 Run 下钻完成 | 生产日志平台、告警和长期归档待部署 |
| M4-09 通知和错误体验 | 结构化对象、原因、建议、Trace 与可重试语义完成 | 外部通知渠道和升级策略待部署 |

### 2.3 M5 工程验证

- M5-01：Vitest、Node Test、API 契约、PostgreSQL 集成和 Playwright E2E 已进入 CI；
- M5-02：越权、跨 Workspace、路径穿越、恶意签名、脱敏、Secret 与 DSH 环境隔离验证完成；
- M5-03：Worker 崩溃、取消、超时、模型/Tool/网络错误、SSE 重连和服务重启验证完成；
- M5-04：控制面完成并发 1/3/5 与 50 Run 排队验证，真实 DSH 留存 1/3/5 参考基线；
- R-15 默认模型链路已经恢复并通过模型、Tool、Artifact 和浏览器文件分析复验。

### 2.4 M6 身份工程

2026-09-01 已完成：

- AI Hub OIDC Authorization Code + PKCE；
- `state`、`nonce`、JWT、Issuer、Audience、Scope 和 JWKS 校验；
- 服务端加密 Session、稳定外部身份映射和退出；
- AI Hub 环境初始管理员一次性初始化首位本地管理员；
- AI Hub 员工目录增量/全量同步，停用员工自动撤销 Session；
- 角色、功能权限、用户/角色数据范围和会话撤销在 dsh-work 管理端配置；
- Workbench/Admin 双 Audience 统一鉴权；
- 全部业务 API 使用 dsh-work 本地授权版本和 RBAC，移除 AI Hub 在线业务授权；
- 移除浏览器可伪造的用户和操作人字段；
- 两个前端的自动登录、无权限、鉴权失败与退出体验；
- OIDC、PKCE、JWKS、密文和会话单元测试。

平台侧未配置和未 UAT 前，以上结论只能表述为“身份接入工程完成”。

## 3. 正式试点开放 Gate

| Gate | 当前状态 | 关闭条件 |
|---|---|---|
| D-03 / AI Hub 身份联调 | 代码完成，平台配置待执行 | 注册唯一应用环境、负责人和两个回调；分配身份/Bootstrap/Directory Scope；凭据进入 Secret Manager；完成首登、同步、本地收权和故障 UAT |
| D-05 企业只读 Connector | 未关闭 | 明确系统与接口 Owner、Schema、数据范围、超时、审计和错误口径，完成真实只读调用 |
| D-06 真实知识源 | 未关闭 | 明确 API/目录、权限、版本、生效时间和引用口径，完成授权过滤 UAT |
| D-07 / D-09 文件与数据安全 | 未关闭 | 确定正式存储、企业恶意文件扫描、保留/清理、数据分级和模型出口规则 |
| D-08 目标部署环境 | 未关闭 | 锁定 Mac mini/等价主机、内存、磁盘、UPS、网络、TLS 和正式并发 |
| D-04 试点数据 | 未关闭 | 确定试点用户、角色、团队空间和真实验收样例 |
| D-10 运维参数 | 未关闭 | 日志、指标、告警、备份周期、保留期和恢复目标完成评审与演练 |
| 生产安全与发布评审 | 未关闭 | 生产配置、渗透/安全评审、回滚、值守和 Go/No-Go 签署 |

任何合成知识、本地只读 Tool、原型身份或确定性测试 Runtime 都不能用于关闭对应企业 Gate。

## 4. 下一执行顺序

1. 在 AI Hub 创建唯一 dsh-work 应用环境，指定首位管理员并配置两个回调以及 Identity/Bootstrap/Directory Scope；
2. 将客户端 Secret 与 Session Secret 放入受管 Secret 存储，完成负责人首登、员工同步、本地授权收回和 AI Hub 故障联调；
3. 确定首个企业只读 Connector 和真实知识源，完成 Schema、数据范围、审计和业务口径评审；
4. 锁定目标主机、HTTPS、网络、生产文件存储、恶意文件扫描、日志监控和告警；
5. 在目标环境重跑真实 DSH 1/3/5 并发、20 MB 文件、长对话、备份恢复和故障演练；
6. 准备试点用户、Workspace、知识、Tool 和业务样例，执行三类核心场景、越权和失败恢复 UAT；
7. 完成员工/管理员使用说明、发布与回滚评审后，决定是否进入 M7 部门试点。

## 5. MVP 必测业务用例

- 普通员工在个人空间创建对话并完成真实 Run；
- 团队成员在团队空间使用授权 Agent、知识、文件和只读 Tool；
- 非成员、无角色、缺数据范围和已收回权限的账号均失败关闭；
- 取消、超时、Worker 崩溃、模型/Tool/网络异常和 SSE 断线具备确定终态与恢复说明；
- 文件上传、解析、Run 绑定、成果版本和下载权限可追溯；
- 管理员可以治理 Agent/Skill/Tool/Runtime，普通员工不能执行管理写操作；
- 审计可沿 User → Workspace → Session → Run → Attempt → Model/Tool/Artifact 追踪且不暴露敏感正文；
- AI Hub 登录、退出、Session 过期、员工停用、dsh-work 本地权限收回、平台不可用和双 Audience 隔离通过 UAT；
- 备份可恢复，版本与数据库迁移可以按发布方案回滚应用。

## 6. 质量与复验入口

```bash
pnpm verify:m0
pnpm verify:m1
pnpm verify:m2
pnpm verify:m3
pnpm verify:m4
pnpm verify:m5:test
pnpm verify:m5:security
pnpm verify:m5:faults
pnpm verify:m5:capacity
pnpm test:sso
pnpm ci:check
```

PostgreSQL 集成测试必须指向专用测试库；真实模型与目标硬件探针只在明确允许产生调用和资源消耗时人工执行。

## 7. 证据索引

- [M0 退出检查](m0-exit-checklist.md)
- [M1 退出检查](m1-exit-checklist.md) 与 [Runtime POC](../poc/m1-runtime-poc.md)
- [M2 退出检查](m2-exit-checklist.md)
- [M3 退出检查](m3-exit-checklist.md)
- [M4 总 Gate](m4-exit-checklist.md) 与 `m4-*-checklist.md`
- [M5 自动化](m5-automated-test-baseline-checklist.md)
- [M5 安全](m5-security-testing-checklist.md)
- [M5 故障](m5-runtime-fault-testing-checklist.md)
- [M5 容量](m5-capacity-test-report.md)
- [M6 AI Hub SSO](m6-ai-hub-sso-checklist.md)
- [AI Hub SSO 接入说明](../deployment/ai-hub-sso-integration.md)
- [决策台账](decision-register.md) 与 [风险台账](risk-register.md)
