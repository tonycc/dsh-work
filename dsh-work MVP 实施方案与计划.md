# dsh-work MVP 实施方案与计划

**项目名称：** dsh-work
**计划版本：** V1.1
**计划日期：** 2026-08-29
**计划状态：** 原型已确认，进入 MVP 实施准备
**计划周期：** T0 起 10～12 周完成 MVP 上线准备，部门试点另安排 2～4 周
**实施架构：** 两个独立 Vue 应用 + 一个 Node.js 模块化单体 + PostgreSQL + 独立 DSH Worker 子进程
**首期部署：** 公司内网 Mac mini
**关联文档：** [产品设计方案](dsh-work%20产品设计方案.md) · [产品架构方案（简化版）](dsh-work%20产品架构方案（简化版）.md) · [前端原型评审说明](前端原型评审说明.md)

> 本文是研发、测试、部署和试点验收的执行基线。产品范围以《dsh-work 产品设计方案》为准，系统边界以《dsh-work 产品架构方案（简化版）》为准，页面和交互以已确认的前端原型为准。发生冲突时，先形成变更记录，再修改计划和对应方案，不允许开发人员自行扩大 MVP 范围。

---

# 一、实施结论

原型确认后，项目进入 MVP 实施阶段。实施不从继续扩展页面开始，而从最高技术风险开始：先验证 DeepSeek Harness（DSH）、Runtime Adapter、模型、受控 Tool 和文件成果的真实执行链路，再沿着同一架构完成 PostgreSQL、企业身份、权限、审计和 Mac mini 部署。

MVP 的第一条可运行主链路必须是：

```text
企业用户登录
  → 发起对话或进入团队工作空间
  → 创建 Session / Run / Attempt
  → Runtime Adapter 启动独立 DSH Worker
  → DSH 通过 Model Gateway 和 Connector Gateway 执行
  → Run Event 通过 SSE 返回员工工作台
  → 消息、事件、Token、审计和成果持久化
  → 管理后台查看 Session、Runtime、用量和审计
```

一期继续坚持以下边界：

- 员工工作台与管理后台独立构建、独立路由、独立接口客户端；
- Node.js 服务端保持一个模块化单体，不拆业务微服务；
- 一个 Attempt 默认启动一个独立 DSH Worker 子进程；
- Runtime 是长期运行环境，不等于单个 DSH Worker 子进程；
- 只支持团队工作空间，不建设个人工作空间；
- 不建设独立的全量对话记录页面，最近对话承担快速回访；
- 不实现 PPT 生成；
- 不开放自定义 Tool 和 Connector，首批能力由实施团队预置；
- 不开放任意 Shell、SQL、员工自装插件或 MCP；
- 不以接入 AI Hub 作为 MVP 前置条件。

---

# 二、当前基线与实施差距

## 2.1 已完成基线

| 能力 | 当前状态 |
|---|---|
| 员工工作台 | Vue 3 原型已完成并确认主要交互 |
| 管理后台 | Vue 3 原型已完成，覆盖 Agent、Skill、预置工具/连接器、Runtimes、Session、工作空间、权限、用量、审计和健康 |
| 前端工程边界 | 两个独立应用，共享无业务状态的 Design Token 和基础组件包 |
| 服务端边界 | 已有 Node.js 模块化单体骨架和员工端、管理端两个 API 门面 |
| 原型数据 | 已有进程内 Prototype Repository 和可验证 Mock 数据 |
| 质量基线 | 已有 typecheck、lint、UI 契约、架构边界检查和 build 命令 |
| 产品与架构 | 已有 MVP 范围、对象模型、模块边界、部署方案和演进原则 |

## 2.2 尚未完成的真实能力

| 能力 | 当前缺口 | MVP 目标 |
|---|---|---|
| DSH | 未接入 | 固定版本、可启动、可取消、可超时、可回收 |
| Runtime Adapter | 只有设计 | 具备 Manifest、事件转换、Worker 生命周期和契约测试 |
| 数据库 | 进程内内存数据 | PostgreSQL、迁移、事务、索引、备份和恢复 |
| 企业身份 | Mock 角色 | 企业 SSO 或受控内部账号、服务端会话和授权 |
| 员工端运行 | 前端动画模拟 | 服务端创建 Run，SSE 返回真实标准事件 |
| 模型 | 未连接 | 一个经批准的 Provider，通过 Model Gateway 调用 |
| Tool/Connector | Mock | 1 个模拟 Tool、至少 1 个真实只读 Tool，最终预置 3～5 个 |
| 文件 | 浏览器模拟 | 上传校验、安全工作目录、解析和清理 |
| Artifact | 浏览器生成下载 | 服务端版本、来源、权限、下载和备份 |
| 安全审计 | Mock 数据 | Run、Attempt、模型、Tool、Artifact 和管理操作真实记录 |
| 运维 | 开发进程 | HTTPS、自启动、日志、监控、告警、备份和回滚 |
| 测试 | 构建检查为主 | 单元、契约、集成、端到端、安全、恢复和容量测试 |

---

# 三、实施前提与计划假设

## 3.1 执行角色与个人项目模式

当前为个人项目，由项目 Owner 一人承担产品、技术、开发、测试、安全和运维责任。下表保留的是实施时必须覆盖的专业视角，不代表必须设置不同负责人或等待多人签字。质量确认以自动化门禁、可复现证据和项目 Owner 决策记录为准。

| 角色 | 建议投入 | 主要责任 |
|---|---:|---|
| 产品负责人/业务分析 | 1 人 | 范围、业务口径、验收、试点协调 |
| 前端工程师 | 1 人 | 员工工作台和管理后台真实接口化 |
| 平台后端工程师 | 1～2 人 | 领域、API、PostgreSQL、权限、网关和 Artifact |
| Runtime 工程师 | 1 人 | DSH、Runtime Adapter、Worker、事件和隔离 |
| AI/Tool 工程师 | 1 人或兼职 | Agent、Skill、模型、Tool Schema 和效果评测 |
| 运维与安全 | 0.5～1 人 | Mac mini、网络、Secret、审计、备份和监控 |
| 测试/业务专家 | 0.5～1 人 | 测试数据、用例、业务正确性和验收 |

原计划周期按 5～7 人可以并行工作估算。个人执行时保持依赖顺序，整体周期按实际投入顺延，不通过省略安全、权限、恢复和验收步骤压缩周期。

## 3.2 估算规则

- `T0` 表示 MVP 正式启动日；
- 工期使用工作周，工作量使用人日；
- 表中工作量用于排期，不是固定承诺；
- 外部接口、SSO、模型审批和安全评审的等待时间单独跟踪；
- 任一阶段未通过退出门槛，不进入依赖该阶段的生产实现。

## 3.3 启动前必须明确的外部条件

| 编号 | 决策事项 | 最晚确认时间 | 责任角色 | 未确认影响 |
|---|---|---|---|---|
| D-01 | DSH 仓库、版本/Commit、CLI 或 SDK 入口、授权方式 | T0+2 天 | Runtime 工程师 | Runtime POC 无法开始 |
| D-02 | 首个模型 Provider、模型、区域、数据条款和 Token 预算 | T0+3 天 | 产品、AI、安全 | 无法验证真实模型链路 |
| D-03 | 企业 SSO 方式和测试账号 | T0+5 天 | 平台后端、企业 IT | 身份与权限只能继续 Mock |
| D-04 | 首个试点部门和 20～50 名目标用户 | T0+5 天 | 产品负责人 | 数据范围和验收口径不明确 |
| D-05 | 首批 3～5 个只读 Tool、接口 Owner 和测试环境 | T0+5 天 | 业务专家、系统 Owner | Connector 工作无法排期 |
| D-06 | 企业知识来源、版本口径和访问接口 | T0+5 天 | 业务专家 | 知识场景无法真实验收 |
| D-07 | Artifact 使用本地目录还是 NAS、保留期和容量 | T0+5 天 | 运维、安全 | 文件结构与备份方案不明确 |
| D-08 | Mac mini、固定 IP、域名、证书、网络和 UPS | T0+10 天 | 运维 | 无法进行部署验证 |
| D-09 | L2 数据字段、脱敏规则和外部模型边界 | T0+10 天 | 安全、业务 Owner | ERP/MES 场景可能被阻塞 |
| D-10 | 服务时间、维护窗口、RTO、RPO 和告警责任人 | T0+15 天 | 产品、运维 | 上线门槛无法验收 |

---

# 四、总体里程碑与排期

| 里程碑 | 建议时间 | 目标 | 退出门槛 |
|---|---|---|---|
| M0 实施基线冻结 | 第 1 周 | 决策、契约、数据和任务基线可执行 | P0 决策有 Owner；OpenAPI/数据模型评审完成；原型基线锁定 |
| M1 Runtime 技术 POC | 第 1～3 周 | 验证 DSH 真实执行可行性 | 浏览器可启动、流式查看、取消和超时一个真实 Run；模型与至少一个只读 Tool 可调用 |
| M2 平台基础能力 | 第 2～5 周 | 建立持久化、身份、权限和核心模块 | PostgreSQL Repository、迁移、服务端鉴权、Agent/Workspace/Session/Run 基础接口可用 |
| M3 端到端垂直闭环 | 第 4～7 周 | 完成员工真实对话主链路 | 新对话、工作空间对话、SSE、文件、Artifact、审计完整贯通 |
| M4 MVP 功能完成 | 第 7～9 周 | 补齐三类核心场景和管理能力 | 原型确认范围全部连接真实 API；3～5 个预置只读 Tool 可运行 |
| M5 上线准备 | 第 9～10 周 | 完成安全、容量、恢复和部署 | Mac mini 预生产部署；安全、备份恢复、故障和容量测试通过 |
| M6 业务验收与试点启动 | 第 11～12 周 | 完成 UAT 和试点发布 | 业务验收通过；培训、值守、反馈和回滚方案就绪 |
| M7 部门试点 | 上线后 2～4 周 | 验证真实价值和稳定性 | 无安全事故；核心指标达标或形成明确整改和投资决策 |

关键路径：

```text
D-01/D-02/D-05 外部决策
  → M1 DSH Runtime POC
  → Run / Attempt / Run Event 持久化
  → SSE 真实对话闭环
  → 文件、Tool、Artifact 与权限贯通
  → 安全和恢复验收
  → Mac mini 发布
```

Agent、Skill、管理列表、用量报表等治理功能可以与关键路径并行，但不得阻塞主链路验证。

---

# 五、工作分解结构（WBS）

## 5.1 M0：实施基线冻结

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M0-01 | 原型确认归档 | 标记当前员工端、管理端路由和交互为 MVP 基线；记录已确认和暂不实现项 | 无 | 产品、前端 | 1 人日 |
| M0-02 | 源码与发布基线 | 建立正式版本库、分支和发布标签；若版本库尚未初始化，先完成 Git 基线 | 无 | 技术负责人 | 1 人日 |
| M0-03 | 工程质量基线 | CI 执行安装、typecheck、lint、UI 契约、架构检查和 build | M0-02 | 前端、后端 | 2 人日 |
| M0-04 | API 契约基线 | 形成员工 API、管理 API 和内部 Runtime/Model/Tool/Artifact 接口的 OpenAPI 或等价契约 | 产品方案 | 后端、前端 | 3 人日 |
| M0-05 | 数据模型评审 | 确认核心表、ID、状态机、唯一约束、索引、保留和删除策略 | 产品方案 | 后端、安全 | 3 人日 |
| M0-06 | 测试数据基线 | 建立用户、角色、工作空间、文件、订单、工单和知识文档测试集 | D-04～D-06 | QA、业务专家 | 3 人日 |
| M0-07 | 决策与风险台账 | D-01～D-10 全部指定 Owner、截止时间和替代方案 | 无 | 产品负责人 | 1 人日 |

M0 退出检查：

- 当前原型可重复启动并通过现有质量命令；
- 每个 MVP 页面能映射到 API、数据表和验收用例；
- 所有 P0 外部依赖有 Owner；
- 没有把微服务、自定义 Tool/Connector 或 PPT 重新加入一期。

## 5.2 M1：DSH Runtime Adapter POC

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M1-01 | 固定 DSH 版本 | 记录仓库、Commit、构建方式、运行依赖、许可和回滚版本 | D-01 | Runtime | 1 人日 |
| M1-02 | Headless Worker 冒烟 | 命令行输入一条任务，输出结构化事件和最终结果 | M1-01、D-02 | Runtime、AI | 2 人日 |
| M1-03 | Runtime Adapter 骨架 | 实现 `execute/subscribe/cancel/status/close/health` 契约 | M0-04、M1-02 | Runtime | 4 人日 |
| M1-04 | Manifest 编译 | Run、用户、Workspace、Agent Version、Skill、Tool、数据范围和挂载点生成不可变 Manifest 与 SHA-256 | M0-05 | Runtime、后端 | 3 人日 |
| M1-05 | Worker 生命周期 | 每 Attempt 独立目录和子进程；启动、退出、异常、清理和资源回收可观测 | M1-03 | Runtime | 4 人日 |
| M1-06 | 标准事件转换 | 将 DSH 原始事件转换为标准 Run Event，过滤内部思维链和敏感参数 | M1-03 | Runtime、后端 | 3 人日 |
| M1-07 | 取消、超时和重试 | 用户取消能终止 Worker；超时产生终态；重试创建新 Attempt | M1-05、M1-06 | Runtime、后端 | 3 人日 |
| M1-08 | 模型链路 | DSH 只能通过 Model Gateway 调用一个批准模型并记录 Token、延迟和错误 | D-02、M1-03 | AI、后端 | 3 人日 |
| M1-09 | Tool 链路 | 先接模拟 Tool，再接至少一个真实只读 Tool；权限、超时和审计可验证 | D-05、M1-03 | AI、后端 | 4 人日 |
| M1-10 | 文件与成果冒烟 | Worker 只读输入、仅写 Attempt 输出目录；成果由 Artifact 接口接管 | D-07、M1-05 | Runtime、后端 | 3 人日 |
| M1-11 | Mac mini 资源基线 | 测量 1、3、5 并发的 CPU、内存、磁盘、启动延迟和回收情况 | M1-05 | Runtime、运维 | 2 人日 |
| M1-12 | POC 决策评审 | 明确是否需要最小 DSH Fork、版本锁定方式和未解决风险 | M1-01～M1-11 | 技术负责人 | 1 人日 |

M1 失败时不得直接扩大正式实现。必须在以下选项中形成书面决策：修复 Adapter、维护最小 Fork、降低 MVP 能力，或替换 Runtime。

## 5.3 M2：平台基础能力与 PostgreSQL

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M2-01 | 服务端模块边界 | 按 identity、governance、workspace、session、run、runtime、model、connector、artifact、audit 分模块，保持单一部署单元 | M0-04 | 后端 | 3 人日 |
| M2-02 | PostgreSQL 工程化 | 连接池、迁移、事务、测试数据库、种子数据和健康检查 | M0-05 | 后端、运维 | 4 人日 |
| M2-03 | 身份与组织表 | users、roles、user_roles、data_scopes 及约束 | M2-02、D-03 | 后端 | 3 人日 |
| M2-04 | 治理配置表 | agents、agent_versions、skills、tools 及不可变版本约束 | M2-02 | 后端、AI | 4 人日 |
| M2-05 | 工作空间与会话表 | workspaces、workspace_members、sessions、messages；只支持团队工作空间 | M2-02 | 后端 | 4 人日 |
| M2-06 | 运行表 | runs、runtime_attempts、run_events；状态转换使用事务和幂等键 | M2-02、M1 | 后端、Runtime | 5 人日 |
| M2-07 | 文件与成果表 | files、artifacts、artifact_versions 和来源追溯 | M2-02、D-07 | 后端 | 4 人日 |
| M2-08 | 审计与用量表 | tool_audit_logs、model_usage_records、管理操作审计 | M2-02 | 后端、安全 | 3 人日 |
| M2-09 | Runtime 配置表 | Runtime 注册、健康、最大并发、Attempt 超时和调度状态 | M1、M2-02 | 后端、Runtime | 2 人日 |
| M2-10 | Repository 替换 | PostgreSQL Repository 实现既有端口，Prototype Repository 仅保留开发/演示用途 | M2-03～M2-09 | 后端 | 5 人日 |
| M2-11 | 企业身份接入 | SSO 回调、服务端 Session、登出、用户同步、角色映射和两个 API Audience | D-03、M2-03 | 后端、企业 IT | 5 人日 |
| M2-12 | 服务端授权 | Workspace、Agent、Tool、数据范围和管理角色均在 API 层强制校验 | M2-11、M2-04～M2-05 | 后端、安全 | 5 人日 |

## 5.4 M3：端到端垂直闭环

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M3-01 | 创建 Session/Run API | 员工提交消息后由服务端创建 Session、Run、Attempt 并锁定版本 | M2-04～M2-06 | 后端 | 4 人日 |
| M3-02 | 排队和调度 | 单机数据库状态队列、最大并发、排空/停用 Runtime 和原子认领 | M2-06、M2-09、M1 | 后端、Runtime | 5 人日 |
| M3-03 | SSE 事件流 | 支持断线重连、事件 ID、终态关闭、错误和权限校验 | M1-06、M2-06 | 后端、前端 | 5 人日 |
| M3-04 | 工作台真实运行 | 新对话、连续追问、停止、重试和固定底部输入改为真实 API | M3-01～M3-03 | 前端 | 5 人日 |
| M3-05 | 团队工作空间闭环 | 成员权限、空间内对话、共享文件、成果和右侧信息全部来自服务端 | M2-05、M3-01 | 前端、后端 | 5 人日 |
| M3-06 | 文件上传与解析 | 类型、大小、路径、病毒/安全策略接口、解析状态和失败反馈 | M2-07、D-07 | 后端、前端 | 5 人日 |
| M3-07 | Artifact 发布与下载 | 版本、来源 Run、预览元数据、下载鉴权和不可覆盖 | M1-10、M2-07 | 后端、前端 | 5 人日 |
| M3-08 | 模型记录 | 每次调用记录 Provider、模型、Token、时延、状态、Trace 和成本估算 | M1-08、M2-08 | 后端、AI | 3 人日 |
| M3-09 | Tool 审计 | 每次调用记录用户、Run、Tool、数据范围、参数摘要、结果和错误 | M1-09、M2-08 | 后端、安全 | 3 人日 |
| M3-10 | 管理运行视图 | Runtimes、Session、审计、模型用量和系统健康显示真实数据 | M2、M3-02～M3-09 | 前端、后端 | 5 人日 |

M3 的唯一验收主场景：使用一个真实企业测试账号，从浏览器提交任务，DSH 调用真实模型和一个真实只读 Tool，生成一个可下载 Artifact，并能在管理后台追踪完整链路。

## 5.5 M4：MVP 功能完成

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M4-01 | Agent 管理 | 创建、测试、发布、停用、版本和回滚；创建人自动成为负责人且创建页不展示负责人 | M2-04、M3 | 后端、前端、AI | 5 人日 |
| M4-02 | Skill 管理 | 标识自动生成且不可修改；创建、编辑、测试、版本、启停和引用 Tool | M2-04、M3 | 后端、前端、AI | 4 人日 |
| M4-03 | 预置 Tool/Connector | 通过代码或受控配置交付 3～5 个只读 Tool；后台仅查看、授权、启停和健康检查 | D-05、M1-09 | 后端、AI | 8～15 人日 |
| M4-04 | 企业知识查询 | 接入一个知识源，回答带来源、文档版本和权限过滤 | D-06、M3 | AI、后端 | 5 人日 |
| M4-05 | 文件分析 | XLSX、CSV、PDF、DOCX 基础解析、限制、失败提示和结果追溯 | M3-06 | 后端、AI | 6 人日 |
| M4-06 | 权限与数据范围 | 成员、角色、Agent、Tool、Workspace 和业务数据范围端到端生效 | M2-12、M3 | 后端、前端、安全 | 5 人日 |
| M4-07 | Runtime 运维配置 | 最大并发、超时、接收任务/排空/停用和健康检查接入真实 Runtime | M2-09、M3-02 | Runtime、后端、前端 | 3 人日 |
| M4-08 | 审计与运营 | 运行、模型、Tool、成果、管理操作和失败事件可查询与下钻 | M2-08、M3 | 后端、前端 | 4 人日 |
| M4-09 | 通知和错误体验 | 待审批、失败、超时、连接器异常和下载失败有明确对象、原因和下一步 | M3 | 前端、后端 | 3 人日 |

## 5.6 M5：安全、测试和部署

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M5-01 | 自动化测试基线 | 前端组件/Store、后端领域、Repository、API、Runtime 契约和 E2E 测试进入 CI | M2～M4 | QA、研发 | 8 人日 |
| M5-02 | 权限与安全测试 | 越权、跨 Workspace、路径穿越、恶意文件、日志脱敏、Secret 和 Tool Allowlist 测试 | M4 | 安全、QA | 5 人日 |
| M5-03 | 运行故障测试 | Worker 崩溃、取消、超时、模型失败、Tool 超时、断网、SSE 重连和服务重启 | M3～M4 | Runtime、QA | 4 人日 |
| M5-04 | 容量测试 | 1、3、5 并发和 50 个排队 Run；记录响应、内存、CPU、磁盘和失败率 | M4、D-08 | 运维、QA | 3 人日 |
| M5-05 | Mac mini 部署 | Reverse Proxy、HTTPS、两个 Vue 构建物、Node.js、PostgreSQL、目录和自启动 | D-08、M4 | 运维、后端 | 5 人日 |
| M5-06 | Secret 和网络 | 模型/Connector 凭据仅在服务端；最小出站访问、防火墙和内部端口隔离 | D-02、D-05、D-08 | 运维、安全 | 3 人日 |
| M5-07 | 日志监控告警 | 结构化日志、Trace、磁盘、内存、队列、Runtime、模型和 Tool 告警 | M4、D-10 | 运维、后端 | 4 人日 |
| M5-08 | 备份恢复 | PostgreSQL、Artifact、配置备份；完成一次可记录的恢复演练 | D-07、D-10 | 运维、后端 | 3 人日 |
| M5-09 | 发布与回滚 | 版本清单、数据库前向迁移、应用回滚、DSH 回滚和维护窗口步骤 | M5-05～M5-08 | 技术负责人 | 2 人日 |

## 5.7 M6：业务验收与试点启动

| ID | 工作项 | 主要交付和完成定义 | 依赖 | 主责 | 估算 |
|---|---|---|---|---|---:|
| M6-01 | UAT 用例执行 | 三类核心场景、权限、失败、成果和审计用例全部执行并留证 | M5 | 产品、QA、业务专家 | 5 人日 |
| M6-02 | 试点数据准备 | 用户、角色、团队工作空间、知识、Tool 数据范围和示例文件导入 | D-04～D-06、M5 | 后端、业务专家 | 3 人日 |
| M6-03 | 培训和使用说明 | 员工、管理员、安全审计员三类说明及已知限制 | M5 | 产品 | 2 人日 |
| M6-04 | 发布评审 | 产品、技术、安全、运维和业务共同签署 Go/No-Go | M6-01～M6-03 | 产品负责人 | 1 人日 |
| M6-05 | 试点值守 | 每日检查失败、Token、Tool、Runtime、磁盘和用户反馈 | M6-04 | 全体 | 试点期持续 |

---

# 六、技术实施顺序

## 6.1 服务端模块落地顺序

```text
第一批：identity + database + governance
  ↓
第二批：workspace + session + run
  ↓
第三批：runtime + model + connector
  ↓
第四批：artifact + audit + usage
  ↓
第五批：employee/admin API 门面和运维接口
```

所有模块继续运行在同一个 `dsh-work-app` 中。逻辑模块使用端口和依赖方向隔离，但不创建独立业务服务、独立数据库或分布式事务。

## 6.2 PostgreSQL 迁移批次

| 批次 | 表 | 关键约束 |
|---|---|---|
| DB-01 身份 | users、roles、user_roles、data_scopes | 企业用户 ID 唯一；停用用户不能创建 Run |
| DB-02 治理 | agents、agent_versions、skills、tools | 稳定 ID；已发布版本不可原地修改 |
| DB-03 协作 | workspaces、workspace_members | 一期只允许 `team` 类型；成员关系显式授权 |
| DB-04 对话 | sessions、messages | Session 属于唯一用户上下文和可选 Workspace |
| DB-05 运行 | runs、runtime_attempts、run_events | 状态转换幂等；Attempt 属于唯一 Run；事件 ID 单调可续传 |
| DB-06 文件 | files、artifacts、artifact_versions | 路径不进入业务主键；Artifact Version 可追溯 Run |
| DB-07 治理记录 | tool_audit_logs、model_usage_records、approvals | 敏感参数脱敏；关联用户、Run 和 Trace |
| DB-08 运维 | runtimes、system_settings | Runtime 健康状态与调度状态分离；配置修改审计 |

迁移规则：

- 每个迁移可在空库和已有上一版本数据库上执行；
- 发布后不修改历史迁移；
- 删除列或表必须经过独立数据保留评审；
- Repository 集成测试使用真实 PostgreSQL；
- Prototype Repository 不与 PostgreSQL 双写。

## 6.3 API 实施优先级

员工 API 第一优先级：

```text
GET    /api/workbench/v1/session
GET    /api/workbench/v1/workspaces
GET    /api/workbench/v1/workspaces/:workspaceId
POST   /api/workbench/v1/workspaces/:workspaceId/files
POST   /api/workbench/v1/sessions
GET    /api/workbench/v1/sessions/:sessionId
POST   /api/workbench/v1/sessions/:sessionId/runs
GET    /api/workbench/v1/runs/:runId
GET    /api/workbench/v1/runs/:runId/events
POST   /api/workbench/v1/runs/:runId/cancel
POST   /api/workbench/v1/runs/:runId/retry
GET    /api/workbench/v1/artifacts
GET    /api/workbench/v1/artifacts/:artifactId/versions/:versionId/download
```

管理 API 第一优先级：

```text
GET/PATCH  /api/admin/v1/agents...
GET/PATCH  /api/admin/v1/skills...
GET/PATCH  /api/admin/v1/tools...
GET        /api/admin/v1/connectors
POST       /api/admin/v1/connectors/check
GET        /api/admin/v1/runtimes
PATCH      /api/admin/v1/runtimes/configuration
POST       /api/admin/v1/runtimes/check
GET        /api/admin/v1/sessions
GET        /api/admin/v1/workspaces
GET/PATCH  /api/admin/v1/roles...
GET        /api/admin/v1/members
GET        /api/admin/v1/audit-events
GET        /api/admin/v1/model-usage
GET        /api/admin/v1/health
```

契约要求：

- 两个前端分别维护面向自身 API 的 DTO；
- 正式实现由 OpenAPI 或等价契约生成/校验客户端类型；
- 错误必须包含稳定错误码、用户可理解信息和可选 Trace ID；
- SSE 支持 `Last-Event-ID` 或等价游标恢复；
- 员工 API 不返回管理字段和敏感运行诊断；
- 管理 API 默认不返回消息正文，审计授权后才能下钻敏感内容。

## 6.4 Mock 替换顺序

| 当前实现 | 正式替换 | 替换完成条件 |
|---|---|---|
| `server/src/infrastructure/prototype` | PostgreSQL Repository | 核心 CRUD、事务、索引和集成测试通过 |
| Workbench 前端运行动画 | Run 命令 API + SSE | 刷新页面后状态仍正确，取消和重连有效 |
| Mock 身份 Store | 企业 SSO + 服务端授权上下文 | 修改前端角色不能扩大权限 |
| 模拟 Runtime | Runtime Adapter + DSH Worker | 健康、容量、排空、停用和执行状态真实 |
| Mock 模型记录 | Model Gateway | Token、延迟、错误和成本真实记录 |
| Mock Tool/Connector | 预置 Tool + Connector Gateway | 权限、数据范围、超时、字段过滤和审计有效 |
| 浏览器 Blob 成果 | Artifact Service + 本地目录/NAS | 版本、来源、下载鉴权和备份有效 |
| Mock 管理命令 | PostgreSQL 命令处理 | 发布、回滚、权限和 Runtime 配置可持久化审计 |

替换策略是逐条主链路切换，不是一次性删除所有 Mock。每完成一个正式适配器，保留明确的开发环境选择开关和契约测试，禁止在生产模式回退到 Prototype Repository。

---

# 七、测试与验收计划

## 7.1 测试层级

| 层级 | 重点 |
|---|---|
| 单元测试 | 状态机、权限、Manifest、事件转换、字段过滤、Artifact 版本 |
| Repository 集成测试 | PostgreSQL 约束、事务、幂等、分页、并发认领和迁移 |
| Runtime 契约测试 | DSH 启动、事件、取消、超时、Tool、文件和版本兼容 |
| API 契约测试 | 两个 API Audience、错误码、权限、DTO 和 SSE 恢复 |
| 前端测试 | Store、表单校验、加载/空/错/无权限状态和关键组件 |
| 端到端测试 | 登录、对话、工作空间、文件、成果、管理和审计链路 |
| 安全测试 | 越权、跨空间、路径、凭据、日志脱敏、模型出口和 Tool Allowlist |
| 故障测试 | Worker 崩溃、服务重启、模型/Tool 超时、数据库恢复和磁盘不足 |
| 容量测试 | 3～5 并发 Run、50 个排队 Run、20 MB 文件和长对话 |

## 7.2 MVP 必测业务用例

| ID | 用例 | 验收结果 |
|---|---|---|
| UAT-01 | 未绑定工作空间的新对话 | 创建 Session/Run，流式返回，最近对话可回访 |
| UAT-02 | 团队工作空间内对话 | Session 锁定当前空间，成员和文件权限正确 |
| UAT-03 | 企业知识问答 | 返回答案、引用、文档版本和数据范围 |
| UAT-04 | ERP/MES 只读查询 | 只调用 Allowlist Tool，结果字段过滤，审计完整 |
| UAT-05 | 文件分析 | 支持规定文件，生成可下载成果，来源可追溯 |
| UAT-06 | 连续追问 | 同一 Session 创建新 Run，不覆盖历史消息 |
| UAT-07 | 取消和超时 | Worker 终止，Run 进入正确终态，临时资源回收 |
| UAT-08 | 失败重试 | 同一 Run 创建新 Attempt，历史 Attempt 保留 |
| UAT-09 | 越权访问 | API 拒绝并记录审计，前端不展示无权限写操作 |
| UAT-10 | Runtime 排空 | 不接收新任务，当前 Worker 自然完成 |
| UAT-11 | Artifact 版本 | 新版本不覆盖旧版本，下载权限和来源正确 |
| UAT-12 | 管理追踪 | 可从 Session/Run 下钻 Runtime、模型、Tool、Artifact 和 Trace |

## 7.3 量化验收门槛

| 类型 | 指标 | MVP 门槛 |
|---|---|---:|
| 产品 | 三类核心场景端到端可用 | 3 类全部完成 |
| 产品 | 员工任务完成率 | ≥ 80% |
| 产品 | 文件成果生成成功率 | ≥ 90% |
| 技术 | Tool 调用成功率 | ≥ 95% |
| 技术 | Run 状态可追踪率 | 100% |
| 技术 | Run/Attempt/Tool/Artifact 关联完整率 | 100% |
| 技术 | Worker 失败可标记并重试 | 100% |
| 安全 | 越权调用成功次数 | 0 |
| 安全 | 跨 Workspace 文件泄露 | 0 |
| 安全 | 跨用户 Worker 上下文串用 | 0 |
| 安全 | 未审批 L2 数据进入外部模型 | 0 |
| 安全 | 未注册 Tool 调用 | 0 |
| 运维 | PostgreSQL 和 Artifact 恢复演练 | 通过 |

---

# 八、部署、发布与运行计划

## 8.1 Mac mini 目标部署

```text
Mac mini
├── Reverse Proxy：HTTPS、静态资源、API 转发、基础限流
├── workbench-web：独立 Vue 构建物
├── admin-web：独立 Vue 构建物
├── dsh-work-app：一个 Node.js 模块化单体
├── PostgreSQL
├── DSH Worker：由 Runtime Adapter 按 Attempt 启动
└── persistent-data
    ├── uploads
    ├── workspaces
    ├── artifacts
    ├── runtime-logs
    └── backups
```

## 8.2 环境划分

| 环境 | 用途 | 数据 |
|---|---|---|
| local | 日常开发 | Mock 或本地测试数据 |
| integration | PostgreSQL、DSH、模型和 Tool 联调 | 脱敏测试数据 |
| staging | Mac mini 上线前验证 | 与生产结构一致的脱敏数据 |
| pilot | 部门试点 | 经批准的真实用户和数据范围 |

MVP 可以让 integration 和 staging 共享一台受控设备，但数据库、文件目录、凭据和域名必须隔离。

## 8.3 每次发布检查

```text
pnpm typecheck
pnpm validate:ui
pnpm lint
pnpm build
服务端单元/集成测试
Runtime 契约测试
关键 E2E 冒烟
数据库迁移预演
备份状态检查
版本与回滚清单确认
```

发布失败时，优先回滚应用和 DSH 版本；数据库使用兼容性前向迁移，禁止依赖破坏性逆向迁移恢复业务。

## 8.4 运行值守

- 每日查看失败 Run、Worker 异常、模型错误、Tool 超时和磁盘；
- 每周检查 Token、成本、使用率、重复使用和人工反馈；
- 每日备份 PostgreSQL，按策略归档 Artifact；
- 上线前和试点期间至少完成一次恢复演练；
- 告警必须明确责任人、影响对象、原因和下一步；
- 管理后台不可用不应影响已开始的 Run。

---

# 九、职责与协作机制

## 9.1 关键 RACI

当前个人项目将下表所有 `A/R` 统一映射为项目 Owner。表格用于确保实现时覆盖各专业视角，不要求设置额外角色负责人。

| 工作 | 产品 | 前端 | 后端 | Runtime | AI/Tool | 运维安全 | 业务/QA |
|---|---|---|---|---|---|---|---|
| MVP 范围和验收 | A/R | C | C | C | C | C | C |
| API 和数据模型 | C | C | A/R | C | C | C | C |
| DSH/Adapter | I | I | C | A/R | C | C | C |
| 模型和 Tool | C | I | R | C | A/R | C | C |
| 员工与管理前端 | C | A/R | C | I | C | C | C |
| 权限和数据安全 | C | C | R | C | C | A/R | C |
| 部署与恢复 | I | I | R | C | I | A/R | C |
| 业务验收和试点 | A | C | C | C | C | C | R |

说明：`A` 为最终负责，`R` 为执行负责，`C` 为参与评审，`I` 为知会。

## 9.2 执行节奏

- 每周一：确认本周目标、依赖和 Gate；
- 每日：15 分钟同步阻塞、接口变化和风险；
- 每周中：运行一次主链路演示，不能只汇报代码完成量；
- 每周五：按验收条件关闭任务并更新风险台账；
- 每个里程碑：产品、技术、安全和业务共同评审；
- 任一范围变化：记录原因、影响、Owner、验收和是否移出一期。

## 9.3 单项任务完成定义

一个任务只有同时满足以下条件才能标记完成：

- 代码、配置或文档已进入正式版本管理；
- 类型检查、Lint、相关测试和构建通过；
- 加载、空、错、无权限和不可用状态已处理；
- 权限在服务端生效，敏感写操作有确认和审计；
- API、数据库迁移和运行手册同步更新；
- 有可复现的验收证据；
- 没有把临时 Mock 冒充正式实现。

---

# 十、风险与应对

| 风险 | 预警信号 | 应对 |
|---|---|---|
| DSH 接口不稳定 | 取消、事件或 Tool 协议频繁变化 | 固定 Commit、Adapter 隔离、契约测试；必要时最小 Fork |
| 外部接口延期 | SSO、模型、ERP/MES 测试环境未按时提供 | 设明确 Owner 和截止时间；保留模拟接口但不调整正式验收门槛 |
| Mock 与正式实现偏差 | 前端状态只能在本地 Store 维持 | 优先打通服务端 Run/SSE，按主链路逐项替换 Mock |
| 权限范围不清 | 同一问题不同人应看到什么无法回答 | 在 M0 建立测试用户、角色、数据范围和业务样例 |
| Mac mini 容量不足 | 3 并发时交换内存、磁盘或 Worker 不稳定 | M1 建基线；降低并发或升级硬件，不提前拆微服务 |
| 文件安全风险 | 路径穿越、恶意文件、残留临时文件 | 类型/大小校验、隔离目录、扫描接口、定期清理和下载鉴权 |
| 模型数据出口风险 | L2 字段可能进入外部模型 | 数据分级、字段过滤、内部模型或阻断；保留审计证据 |
| Tool 结果不可靠 | Schema 不稳定、超时或口径冲突 | 只读、固定 Schema、Owner 验收、超时重试和来源标注 |
| 一期范围膨胀 | 提出多 Agent 市场、自定义 Connector、微服务或 PPT | 进入后续 Backlog，不改变 M0～M6 关键路径 |
| 恢复能力缺失 | 只有备份文件，没有恢复记录 | M5 必须完成真实恢复演练，未通过不得上线 |

---

# 十一、立即启动清单

从本文批准后的第一个工作日开始执行：

1. 由项目 Owner 统一承担产品、后端、Runtime、前端、AI/Tool、运维安全和业务验收职责；
2. 维护 D-01～D-10 决策项；未确定项在对应里程碑前关闭，不阻塞 M0 基线冻结；
3. 锁定已确认原型和当前文档版本；
4. 建立 CI，确保 `pnpm typecheck`、`pnpm validate:ui`、`pnpm lint`、`pnpm build` 持续通过；
5. 建立 OpenAPI、数据库迁移和自动化测试目录；
6. 创建 M1 DSH POC 分支或任务流；
7. 固定 DSH 版本并完成 Headless Worker 冒烟；
8. 以 `RuntimeAdapter.execute → Run Event → SSE → 员工工作台` 为第一条真实开发链路；
9. 每周演示真实链路，不以管理页面数量作为进度判断；
10. M1 通过后再全面展开 PostgreSQL 和业务功能实施。

---

# 十二、版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| V1.1 | 2026-08-29 | 调整为个人项目单一 Owner 治理；确认 DSH 与 GitHub；M0 评审和测试基线通过 |
| V1.0 | 2026-08-29 | 基于已确认原型、产品方案和架构方案，形成可排期、分工、实施和验收的 MVP 执行基线 |
