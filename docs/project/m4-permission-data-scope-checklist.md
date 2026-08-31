# M4-06 权限与数据范围退出检查

**验证日期：** 2026-08-30

**工程结论：** M4-06 的服务端统一授权、工作空间成员和能力版本授权、Agent/Tool 角色与数据范围校验、Runtime Manifest 身份快照及拒绝审计已经完成。本结论关闭工程基线，不代表企业 SSO、正式组织角色和真实业务数据范围已经完成联合验收。

| 验收项 | 结论 | 验收证据 |
|---|---|---|
| 身份状态 | 已完成 | 租户和用户必须为启用状态；停用主体默认拒绝 |
| 有效角色 | 已完成 | 只采用 `valid_until` 未过期的服务端 `user_roles`；不信任前端角色 Store |
| 工作台权限 | 已完成 | 创建 Session、启动和重试 Run 均要求 `workbench:use` |
| 资源读取权限 | 已完成 | 对话列表、事件流、Agent 列表、工作空间、文件和成果接口先校验工作台身份；资源查询再按 Session Owner 或 Workspace Member 过滤 |
| 工作空间成员 | 已完成 | 团队空间对话要求当前用户是启用空间的成员；平台管理员不自动穿透业务空间 |
| Agent 权限 | 已完成 | Agent Version 必须已发布且所属 Agent 未停用，用户角色命中 `visible_role_ids`；既有 Session 可继续使用其锁定的历史发布版本 |
| Skill/Tool 版本 | 已完成 | Skill、Tool 使用锁定版本；工作空间按 `workspace_capability_grants` 精确授权版本 |
| Tool 权限 | 已完成 | Tool 必须已发布、可用、只读、连接器健康；角色和数据范围同时满足 |
| 数据范围 | 已完成 | 用户、角色和当前工作空间的 `data_scope_grants` 合并后必须覆盖 Agent 和 Tool 要求 |
| 配置前置校验 | 已完成 | Agent 创建、修改、测试、发布和 Runtime 解析时校验可见角色及数据范围能够覆盖所选 Tool |
| 管理端权限 | 已完成 | Agent、Skill、Tool/Connector 写操作要求有效 `admin:*` 角色；普通员工调用被拒绝 |
| Runtime 快照 | 已完成 | 运行清单中的 `user_context.role_ids` 和 `data_scopes` 来自服务端授权决策，不再硬编码 |
| 权限审计 | 已完成 | Runtime/工作台授权的通过和拒绝追加写入 `audit_events`，对象类型为 `authorization` |
| 自动化验证 | 已完成 | PostgreSQL 集成测试覆盖允许、跨空间、缺少能力授权、缺少数据范围、普通员工管理越权和 Manifest 快照 |

## 授权顺序

```text
启用租户与用户
  → 有效角色与 workbench:use
  → 工作空间状态与成员关系（如有）
  → Session 锁定的 Agent 已发布版本与可见角色
  → 用户/角色/工作空间数据范围覆盖
  → Skill/Tool 精确版本与工作空间能力授权
  → Tool 状态、连接器健康、角色和数据范围
  → 生成不可变 Runtime Manifest
```

任一步骤失败都不会创建新的 Run 或 Attempt；错误原因以安全摘要进入授权审计。

## MVP 边界

- HTTP 工作台当前仍使用受控种子用户 `U00001`，这是 D-03 企业 SSO 未确定前的工程入口，不是可上线认证方案。接入 SSO 时必须由网关/服务端会话生成 `userId`，禁止接受客户端自报身份。
- 当前数据范围是受控代码，例如 `enterprise:authorized`、`workspace:authorized` 和试点领域范围；真实组织、部门、区域、成本中心和字段级范围需由 D-03/D-04/D-06 联合确认后导入。
- MVP 工作空间能力授权采用“存在精确授权才允许”的默认拒绝语义。新增工作空间必须显式授予 Agent、Skill 和 Tool Version，不能依赖全局隐式继承。
- 管理端仍使用种子管理员姓名作为原型请求字段，但服务端已强制映射到有效管理员主体。接入真实认证后应移除该请求字段，改用认证上下文。
- 当前授权审计记录安全决策摘要，不记录密钥、消息正文或完整文件内容。

## 复验命令

```bash
pnpm verify:m4:authorization
pnpm ci:check

# 需要一个已迁移或空的测试 PostgreSQL 数据库
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m4:authorization:integration
```
