# MVP 决策台账

**更新时间：** 2026-09-01
**项目治理方式：** 个人项目，项目 Owner 同时承担产品、技术、开发、测试、安全和运维决策；表中的专业角色仅表示评审视角，不代表需要额外人员。

**状态说明：** `已确认`、`已替代`、`待确定`、`阻塞`

## 1. 已确认的内部决策

| 编号 | 决策 | 状态 | 责任角色 | 影响 |
|---|---|---|---|---|
| A-01 | 两个独立 Vue 前端、一个 Node.js 模块化单体 | 已确认 | 项目 Owner | 不拆业务微服务 |
| A-02 | 默认一个 Attempt 一个独立 DSH Worker 子进程 | 已确认 | 项目 Owner | Worker 不是 Runtime 列表项 |
| A-03 | Runtime Adapter 隔离 DSH，产品对象不依赖 DSH 内部结构 | 已确认 | 项目 Owner | 支持替换和升级 DSH |
| A-04 | 一期只支持团队工作空间 | 已替代 | 项目 Owner | 由 A-12 替代；历史无空间会话迁移到个人空间 |
| A-05 | 不建设独立全量对话记录页面 | 已确认 | 项目 Owner | 最近对话和团队空间承担访问入口 |
| A-06 | 一期不开放自定义 Tool/Connector | 已确认 | 项目 Owner | 能力由实施团队预置 |
| A-07 | Agent 创建不配置模型策略；模型由平台级 Model Gateway 管理 | 已确认 | 项目 Owner | Agent 配置保持简化 |
| A-08 | Runtimes 位于安全与运维 | 已确认 | 项目 Owner | 健康状态与调度状态分离 |
| A-09 | Mac mini 为 MVP 首期部署目标 | 已确认 | 项目 Owner | Kubernetes 不是一期依赖 |
| A-10 | 不 Fork DSH；固定 Commit 并通过 ACP、权威 Session Log 和 Session Telemetry 集成 | 已确认 | 项目 Owner | dsh-work 维护 Adapter 和脱敏投影，不修改 DSH 核心 |
| A-11 | DSH 作为受管 Runtime 制品独立交付；不把 DSH 源码并入 dsh-work | 已确认 | 项目 Owner | 本地可使用经校验的源码 checkout；integration、staging、pilot 使用固定版本制品 |
| A-12 | 每位用户自动拥有唯一默认个人工作空间；所有对话、文件和成果必须归属个人或团队空间 | 已确认 | 项目 Owner | 取消“未加入工作空间”；个人空间仅本人访问且不扩大企业权限 |
| A-13 | 企业身份统一使用 AI Hub OIDC；dsh-work 采用 PKCE 和服务端加密 Session，高风险管理写操作使用 AI Hub 在线决策 | 已替代 | 项目 Owner | 由 A-14 替代；保留登录与服务端 Session，移除跨应用业务授权耦合 |
| A-14 | AI Hub 只提供 OIDC 身份、一次性初始管理员和员工目录；dsh-work 持有全部角色、功能权限、数据范围与 Session 授权事实 | 已确认 | 项目 Owner | 类似第三方账号登录；禁止生产回退 Prototype；浏览器不持有 AI Hub Token；员工/管理端共用一个应用 |

## 2. 启动外部决策

| 编号 | 决策事项 | 当前结论/候选 | 状态 | 责任角色 | 截止时间 | 阻塞影响 |
|---|---|---|---|---|---|---|
| D-01 | DSH Runtime 版本和入口 | 本地开发通过 `DSH_RUNTIME_HOME` 指向经校验的源码 checkout；版本 `0.1.1-rc.2`；Commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。integration、staging、pilot 使用包含元数据的受管制品和正式 ACP 入口；Headless CLI 仅作诊断 | 已确认 | 项目 Owner | 2026-08-30 | 服务端启动前校验安装、版本、Commit 和 ACP v1；DSH 不并入 dsh-work 源码 |
| D-02 | 模型 Provider 和预算 | M1/M2 默认使用 `deepseek-official / deepseek-v4-pro`；dsh-work 管理 Provider、模型和平台路由，但不在 Agent 中配置模型策略。运行参数仍继承 DSH 默认配置，正式企业数据出口由 D-09 控制 | 已确认 | 项目 Owner | 2026-08-30 | M2 已增加模型治理表、API、管理页和 Attempt 路由快照；M3 接入真实运行解析 |
| D-03 | 企业身份 | 使用 AI Hub OIDC Authorization Code + PKCE；员工/管理两个 API Audience 共用一个应用环境凭据；平台登记人、业务负责人和环境初始管理员分离，只有环境初始管理员可一次性成为首位本地管理员；业务授权与员工目录同步由 dsh-work 管理 | 工程已确认，AI Hub 配置/联调待完成 | 项目 Owner | 2026-09-02 | 代码不再阻塞；真实凭据、初始管理员认领、目录同步和 OIDC_ONLY 认证仍阻塞试点 |
| D-04 | 试点部门 | 原型使用供应链合成场景，正式试点待确定 | 待确定 | 项目 Owner | M6 数据准备前 | 阻塞正式 UAT，不阻塞 M0 |
| D-05 | 首批 Tool | M4-03 已将 DSH `read`、`glob`、`grep` 三个本地工作空间只读 Tool 纳入版本、权限、健康和 Manifest Allowlist 治理；一期企业 Tool 仍从知识查询、订单、工单、库存和采购到货中按真实接口就绪情况预置，不开放自定义 Tool | 工程基线已确认，企业接入待确定 | 项目 Owner | 2026-08-30 | M1/M4 本地 Tool Gate 不再阻塞；首个企业 Connector 仍是联合试点准入项 |
| D-06 | 企业知识来源 | M4-04 已用 PostgreSQL 受控知识目录和两份明确标记的合成文档验证版本、角色/工作空间过滤、Runtime 注入和来源引用；真实知识库 API 或文档目录、文档 Owner、版本及更新口径仍待确定 | 工程基线已确认，真实来源待确定 | 项目 Owner | 真实知识 UAT 前 | 不再阻塞 M4 工程闭环；仍阻塞真实知识验收 |
| D-07 | 文件与 Artifact 存储 | M3/M4-05 已用 `storage_key` 加本地目录适配器完成单机工程闭环；正式环境仍需确定 NAS/对象存储、保留期、容量、备份和清理策略 | 工程基线已确认，生产方案待确定 | 项目 Owner | M5 部署前 | 不再阻塞 M4 工程闭环；仍阻塞预生产部署和真实文件验收 |
| D-08 | Mac mini 环境 | 固定 IP、域名、证书、网络和 UPS 待确定 | 待确定 | 项目 Owner | M5 部署前 | 阻塞预生产部署，不阻塞 M0 |
| D-09 | L2 数据策略 | 字段、脱敏和外部模型出口规则待确定 | 待确定 | 项目 Owner | 真实企业数据接入前 | 阻塞企业数据验收，不阻塞 M0 |
| D-10 | 服务目标 | 服务时间、维护窗口、RTO、RPO 和告警方式待确定 | 待确定 | 项目 Owner | M5 上线 Gate 前 | 阻塞上线，不阻塞 M0 |

## 3. 工程决策

| 编号 | 决策事项 | 建议 | 状态 | 责任角色 | 截止时间 |
|---|---|---|---|---|---|
| D-11 | 代码托管与 CI Provider | GitHub；仓库内使用 `.github/workflows/ci.yml` 执行 `pnpm ci:check` | 已确认 | 项目 Owner | 2026-08-29 |
| D-12 | PostgreSQL 访问与迁移工具 | 使用 `postgres.js` 轻量驱动、显式 SQL Repository 和顺序 SQL 迁移；不引入领域 Active Record | 已确认 | 项目 Owner | 2026-08-30 |
| D-13 | 自动化测试框架 | Vue 使用 Vitest + Vue Test Utils + happy-dom；浏览器 E2E 使用 Playwright Chromium；服务端保留 Node Test，避免无收益迁移。全部测试由 pnpm 脚本和 GitHub Actions 统一编排 | 已确认 | 项目 Owner | 2026-08-30 |
| D-14 | SSE 续传策略 | 使用稳定 `event_id` 和 `Last-Event-ID`；PostgreSQL `stream_position` 负责全 Run 排序，终态和重试事件均可重放 | 已确认 | 项目 Owner | 2026-08-30 |
| D-15 | Provider 与模型密钥治理 | dsh-work 管理 Provider、模型路由、密钥引用和状态；密钥正文由 `SecretStorePort` 后端保管。MVP 当前继续使用 DSH Credentials Provider，数据库/API/日志不保存或回显密钥；未来可迁移系统钥匙串、企业 Secret Manager 或 Model Gateway | 已确认 | 项目 Owner | 2026-08-30 |

## 4. D-01 实施注意事项

- DeepSeek Harness 当前为预发布版本，必须固定 Commit，不能只依赖宽泛版本范围；
- 候选仓库当前存在未跟踪的 `scratch-plugin/`，锁定版本时必须明确是否属于正式运行闭包；
- 产品命令可完成一次 Headless 任务，但结构化实时事件、取消和嵌入协议仍需 M1 POC 验证；
- D-01 的安装源与版本选择已确认；真实模型、Tool、取消、超时和事件转换属于 M1 POC 验收，不再回退 D-01 状态。
- 交付规范见 `docs/deployment/dsh-runtime-delivery.md`；相邻源码仓库只是 local 回退方式，不是正式部署依赖。

## 5. 更新规则

- 每个待确定项由项目 Owner 补充结论日期和证据链接；涉及外部系统时再记录对应联系人；
- 决策变化必须记录影响的 WBS、接口、数据、测试和排期；
- 不得删除已作废决策，改为增加状态和替代决策；
- 影响 MVP 范围的决策必须同步修改 `docs/architecture/overview.md`、`docs/project/mvp-roadmap.md` 及相关契约和检查表。
