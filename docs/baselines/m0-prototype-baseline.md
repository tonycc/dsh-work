# M0 已确认原型基线

**基线编号：** M0-PROTOTYPE-V0.2
**确认日期：** 2026-08-29
**状态：** 已确认，后续实现不得无记录改变主要信息架构和交互
**详细说明：** [前端原型评审说明](../../前端原型评审说明.md)

## 1. 基线范围

```text
apps/
├── workbench-web       员工工作台
└── admin-web           管理后台

packages/
├── design-tokens       共享设计变量
├── ui-core             无业务状态基础组件
├── workbench-components
└── admin-components

server/
└── src                 Node.js 模块化单体原型接口
```

两个前端独立构建、独立路由、独立 Store 和独立 API DTO。共享包不得保存业务状态、认证状态或服务端领域模型。

## 2. 已确认员工端路由

| 页面 | 路由 | 实施要求 |
|---|---|---|
| 工作台 | `/workbench` | 单一新对话焦点、能力快捷栏、最近对话 |
| 对话 | `/conversations/:id` | 中心消息流、固定底部输入、连续追问、运行详情 |
| 工作空间 | `/workspaces` | 只展示团队工作空间 |
| 工作空间详情 | `/workspaces/:id` | 顶部对话/共享文件/成果页签，右侧稳定空间上下文 |
| 我的成果 | `/artifacts` | 版本、来源 Run、预览和下载 |
| 用户中心 | `/settings` | 企业身份、数据范围和偏好 |

员工端不提供独立的全量对话记录页面。Session 和消息仍完整持久化，用户通过最近对话和团队工作空间访问。

## 3. 已确认管理端路由

| 模块 | 路由 | 实施要求 |
|---|---|---|
| 运营概览 | `/overview` | 运行、成功率、用量、异常和审计摘要 |
| Agent 管理 | `/agents` | 三步创建、测试、发布、停用、版本和回滚 |
| Skill 与工具 | `/capabilities` | Skill 管理；预置 Tool/Connector 查看、权限、启停和健康 |
| Session 列表 | `/sessions` | 治理元数据，不默认展示消息正文 |
| 模型用量 | `/model-usage` | Token、成本、时延、状态和 Trace |
| 工作空间 | `/workspaces` | 团队工作空间治理 |
| 成员管理 | `/members` | 企业身份、角色和数据范围 |
| 权限与数据范围 | `/permissions` | 角色、Agent、Tool 和数据范围 |
| Runtimes | `/runtimes` | 位于安全与运维；健康、容量、超时和调度状态 |
| 审计记录 | `/audit` | Run、模型、Tool、成果和管理操作 |
| 系统健康 | `/health` | 应用、Runtime 和依赖健康 |

## 4. 已确认范围决策

- 一期只支持团队工作空间，不建设个人工作空间；
- 团队工作空间属于责任团队，不属于创建人个人；
- Agent 创建页不显示负责人，创建人自动成为负责人；
- Agent 欢迎语选填，创建流程不配置模型策略；
- Skill 标识由服务端自动生成且不可修改；
- 一期不开放自定义 Tool 和 Connector；
- Runtimes 一期只配置最大并发 Worker、单次执行超时和接收任务/排空/停用；
- PPT 生成不进入一期；
- 员工工作台和管理后台保持独立视觉与组件管理。

## 5. 原型与正式实现边界

原型已确认的是页面、信息架构、权限表现和交互，不代表以下能力已经实现：

- PostgreSQL 持久化；
- 企业 SSO 和服务端授权；
- DSH Worker 和 Runtime Adapter；
- 服务端 Run Event 与 SSE；
- 真实模型、Tool、Connector 和知识库；
- 文件安全、Artifact 服务、备份和恢复；
- 生产日志、监控和告警。

## 6. 基线质量命令

```bash
pnpm verify:m0
pnpm typecheck
pnpm validate:ui
pnpm lint
pnpm build
```

任何实施任务修改确认交互时，必须同步更新本基线、产品方案、相关 UI 契约和验收用例。
