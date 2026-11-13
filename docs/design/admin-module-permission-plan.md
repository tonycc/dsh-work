# 管理端模块权限方案

**状态：** 待评审。决策 AP1～AP8 为建议方案，确认前不实施；本文能力在实施并通过第 8 节验收前均不可用，现行规则仍以[功能规则](../development/feature-rules.md)和代码为准。<br>
**更新日期：** 2026-11-13（初稿）<br>
**依据：** 当前身份与授权实现（`server/src/modules/identity`、`server/src/modules/authorization`、`server/src/http/router.ts`）、[管理端 OpenAPI](../development/openapi-admin.json)、[数据模型第 1 节](data-model.md#1-租户身份与授权)。<br>
**关联：** [架构总览第 9 节](../development/overview.md#9-身份安全与数据边界)、[功能规则第 8 节 Agent 岗位权限](../development/feature-rules.md#8-agent-岗位权限)、[企业组织架构方案](org-structure-plan.md)（部门授权）、[发往模型的数据防护方案](model-data-protection-plan.md)（`data-protection:terms` 先例）。

## 1. 背景与目标

管理端目前只有两级权限：`admin:read` 可查看全部管理页面，`admin:write` 可修改全部管理配置。例外只有三处：员工与权限的写操作只限平台管理员（`admin:*`）；审计与运行治理由 `audit:read` 控制；保密词表与白名单由 `data-protection:terms` 单独控制。

问题：

- 想让一个人只维护企业知识库或只管模型，只能给 `admin:write`，他同时可以改 Agent、Skill、MCP 凭据、钉钉配置；
- “是否是管理员”的判定散落在路由入口、会话层、服务层和多处 SQL 中（第 5 节），单改路由入口无法真正收窄。

目标：

- 管理端按模块授予查看或修改权限，模块管理员只能看到并操作自己的模块；
- 现有角色不迁移、含义不变；
- 不引入新的提权路径：模块管理员不能给自己或他人加权限，也不能经部门、Agent 或管理助手绕过。

## 2. 边界

- **只调整管理端（Admin Audience）。** 员工端权限（`workbench:*`、`knowledge:view|docs|bases`）和项目空间角色不变。
- **不做对象级授权。** 本期按模块授权，不做“只管某几个 Agent / 某几个知识库”；对象级授权另行立项。
- **不改授权机制。** 仍是 `roles.permissions` + `user_roles`，请求时从 PostgreSQL 重新计算，授权变更递增授权版本；不新增权限表。
- **员工与权限仍只限平台管理员**（AP4）。
- **不改 Agent 执行链路。** 管理助手仍经 DSH 执行，本方案只在平台确认入口增加权限校验。

## 3. 待确认决策

| 编号 | 建议 |
| --- | --- |
| AP1 | 权限码命名为 `admin:<模块>:read` / `admin:<模块>:write`，`write` 包含 `read`。`admin:read`、`admin:write` 保留，含义为“全部模块”的查看 / 修改；`admin:*` 不变。前缀统一为 `admin:`，与员工端的 `knowledge:view|docs|bases` 区分 |
| AP2 | 模块按第 4.1 节划分：Agent、Skill、工具与连接、模型、数据防护、企业知识库、组织架构、钉钉集成、运营；审计沿用 `audit:read`，员工与权限沿用 `admin:*`。是否把“模型”与“数据防护”、“工具与连接”与 Skill 合并，评审时确认 |
| AP3 | 跨模块引用：持有某模块写权限时，可读取该模块表单需要的其他模块**选择器精简列表**（ID、名称、状态、版本），不需另授对方模块的查看权限。例如 Agent 草稿页需要 Skill、工具、MCP 连接器、角色、模型路由的候选列表 |
| AP4 | 员工、角色与角色权限、数据范围、目录同步的修改仍只限 `admin:*`，不拆“员工管理员” |
| AP5 | Agent 管理员给 Agent 授岗位权限时：不能授予带 `admin:`、`audit:`、`data-protection:` 前缀权限的角色；授予的数据范围不能超出操作人本人的数据范围。平台管理员不受数据范围限制 |
| AP6 | 运营查看 `admin:ops:read` 覆盖运营概览、Session 摘要、工作空间、Task 汇总、用量与健康状态。Session 摘要含对话标题（员工首条输入的前 40 字），是否改归 `audit:read`，评审时确认 |
| AP7 | 持久化审批（`/approvals`）先归 Agent 模块；接入更多需审批工具后再评估按工具所属模块授权 |
| AP8 | 分两期：AMP-S1 服务端（权限码、路由对照表、会话层、服务层判定、防提权、测试）；AMP-S2 管理端前端（菜单与按钮控制、预置角色、E2E）。AMP-S2 开发前先给可点击原型 |

## 4. 设计

### 4.1 模块与权限码

模块依据管理端 OpenAPI 的路径前缀与管理端菜单划分。

| 模块 | 权限码 | 路径前缀（`/api/admin/v1/`） | 管理端页面 |
| --- | --- | --- | --- |
| Agent | `admin:agent:read` / `write` | `agents`（含 access、routines、validations、versions、runs、workspaces）、`agent-versions`、`experience-iterations`、`approvals` | Agent 管理、Agent 详情与草稿、经验、审批 |
| Skill | `admin:skill:read` / `write` | `skills`、`skill-versions`、`skill-release-records`、`skill-submissions`、`skill-installations` | Skill 管理、待审核、新增 Skill |
| 工具与连接 | `admin:connector:read` / `write` | `connectors`（含 MCP 凭据、能力审批、调用对账）、`runtimes`、`grant-sources`、`task-executions` | MCP 连接器、调用对账、Runtimes |
| 模型 | `admin:model:read` / `write` | `model-providers`、`provider-models`、`model-routes`、`model-usage` | 模型治理、模型用量 |
| 数据防护 | `admin:dlp:read` / `write` | `data-protection` 中除词表、白名单外的接口（概览、命中记录、检测试用） | 数据防护 |
| 企业知识库 | `admin:knowledge:read` / `write` | `knowledge` | 企业知识库 |
| 组织架构 | `admin:org:read` / `write` | `organization` | 组织架构 |
| 钉钉集成 | `admin:dingtalk:read` / `write` | `dingtalk` | 钉钉集成 |
| 运营 | `admin:ops:read` | `sessions`、`workspaces`、`tasks`、`usage`、`health`、`platform-status` | 运营概览、Session 列表、工作空间、健康 |
| 审计（不变） | `audit:read` | `audit-events`、`operations` | 审计、运行治理 |
| 员工与权限（不变） | 写：`admin:*`；读：任一管理权限 | `identity` | 员工与权限 |
| 保密词表（不变） | `data-protection:terms` | `data-protection/terms`、`data-protection/allowlist` | 数据防护中的词表、白名单 |
| 管理助手 | 见 4.4 | `assistant` | 管理助手 |
| 当前会话 | 已登录管理端即可 | `session` | — |

`task-executions` 的人工处置（`/task-executions/:taskId/operations/:operationId/resolve`）是外部写操作的对账，与 MCP 调用对账同属“工具与连接”。

**判定规则：** 请求 `admin:<m>:read` 时，持有 `admin:*`、`admin:read`、`admin:write`、`admin:<m>:read`、`admin:<m>:write` 任一即通过；请求 `admin:<m>:write` 时，持有 `admin:*`、`admin:write`、`admin:<m>:write` 任一即通过。判定集中在一个函数（建议 `server/src/modules/identity/admin-permissions.ts` 的 `hasAdminModuleAccess(permissions, module, level)`），路由、会话层、服务层与前端共用同一份模块清单。

**兼容：** 现有角色不迁移。`role-platform-admin`、带 `admin:read` 的审计员角色等含义不变；新增权限码只用于新建或调整的细分角色。

**预置角色（AMP-S2）：** Agent 管理员（agent + skill 写，connector 读）、知识库管理员（knowledge 写）、模型与数据防护管理员（model + dlp 写）。仅为方便选用，管理员可在“员工与权限”中自行组合。

### 4.2 跨模块引用（AP3）

管理页面存在跨模块的选择器：Agent 草稿的能力步骤列出 Skill、内置工具、MCP 连接器与工具，角色与权限步骤列出角色和数据范围，模型路由选择列出路由。

- 持有 `admin:agent:write` 时，可读取上述候选列表的精简字段（ID、名称、状态、版本、所需角色），不返回凭据、配置正文、调用记录；
- 精简列表复用现有列表接口，通过查询参数（如 `view=selector`）或独立接口返回，服务端按调用者权限决定返回完整还是精简字段；
- 其他模块之间存在同类引用时，按同一规则在实施时逐个登记。

### 4.3 防提权

1. **权限自身只限平台管理员。** 员工、角色、角色权限、用户数据范围、目录同步的修改继续只限 `admin:*`（现有 `router.ts` 对 `/identity/` 写操作的限制保留，AP4）。
2. **部门不能授予任何管理权限。** `DEPARTMENT_FORBIDDEN_PERMISSIONS` 由固定清单改为前缀规则：权限码以 `admin:`、`audit:`、`data-protection:` 开头即不可经部门授予，新增权限码自动覆盖。
3. **Agent 岗位权限有上限（AP5）。** `agent-access-service.ts` 的“含管理权限的角色”判定同样改为前缀规则；非平台管理员给 Agent 授予此类角色时拒绝（平台管理员保持现有的风险提示）。非平台管理员授予的数据范围须为本人数据范围的子集，否则拒绝。
4. **管理助手确认时校验（4.4）。**
5. **默认拒绝。** 管理端路径未在模块对照表登记时一律拒绝，防止新增接口落入无权限检查的状态。

### 4.4 管理助手

管理助手经 DSH `admin-assistant` Run 处理问答和意图提案，确认后调度专用 Run（`admin-skill-install`、`admin-agent-manage`、`admin-platform-operations`），专用 Run 生成精确操作计划，二次确认后复用领域服务写入。

- 进入管理助手、发消息、取消与重试自己的助手 Run：任一管理权限即可（沿用现有“`admin:read` 可发助手消息”的口径）；
- 确认任务提案（`/assistant/task-proposals/:id/confirm`）：按提案类型检查目标模块写权限，`admin-skill-install` 需 `admin:skill:write`，`admin-agent-manage` 需 `admin:agent:write`，`admin-platform-operations` 按提案涉及的操作所属模块检查；
- 确认操作计划（`/assistant/action-plans/:id/confirm`、`/assistant/runs/:id/confirm`）：在写入前按计划中每个操作的目标模块再次检查，任一不满足则整份计划拒绝；
- 权限检查只在平台确认入口执行，不依赖 DSH 只提出有权限的操作；向管理助手提供的上下文可以说明当前管理员的模块范围，以减少无效提案，但不作为授权依据。

### 4.5 前端（AMP-S2）

- 路由 `meta.requiredPermission` 由统一的 `adminRead` 改为模块声明（如 `{ module: 'agent', level: 'read' }`），无权限时进入“无权访问”页；
- 侧栏只显示有查看权限的模块；没有写权限时隐藏或禁用写按钮，并以文字说明原因；
- 当前会话接口返回调用者的模块权限摘要，前端只用于展示，服务端仍逐请求校验；
- “员工与权限”中的权限选择按模块分组展示新增权限码。

## 5. 需要修改的检查点

单改路由入口不能收窄权限。以下各处必须一并处理：

| 位置 | 现状 | 调整 |
| --- | --- | --- |
| [router.ts](../../server/src/http/router.ts) `assertApiRouteAccess` | 按 GET/非 GET 区分 `admin:read` / `admin:write`，`/identity/` 写操作限 `admin:*`，审计路径限 `audit:read` | 改为“路径前缀 → 模块 + 读写级别”对照表，未登记路径拒绝；保留 identity 与审计特例 |
| [auth-service.ts](../../server/src/modules/identity/auth-service.ts) `hasAdminAccess`、`assertAudienceAccess` | 管理端写请求要求 `admin:*` 或 `admin:write` | 准入改为持有任一管理权限码；写请求的模块级判定交给路由对照表，会话层不再按全局写权限拒绝 |
| [platform-admin-actor.ts](../../server/src/modules/authorization/platform-admin-actor.ts) `requirePlatformAdminActor` | 服务层统一判定，条件为 `admin:*` 或 `admin:write`；Agent、组织、知识库、MCP、授权等服务复用 | 新增 `requireAdminActor(sql, userId, module)`，按模块写权限判定；仅平台级操作保留 `requirePlatformAdminActor` |
| `postgres-skill-service.ts`、`admin-skill-installation-service.ts`、`postgres-operations-service.ts`、`postgres-grant-reconciliation-service.ts`、`postgres-authorization-service.ts` 中的 SQL | 各自写了 `r.permissions ? 'admin:*' or ... 'admin:write'` | 逐处定为“对应模块写权限”或“仍限平台管理员”，并改为调用共用判定，不再各自维护 |
| `postgres-organization-service.ts` `DEPARTMENT_FORBIDDEN_PERMISSIONS` | 固定清单 | 前缀规则（4.3） |
| `agent-access-service.ts` | 按清单识别管理类角色 | 前缀规则，非平台管理员授权时执行 AP5 上限 |
| `dingtalk-admin-service.ts` `administrativePermissions` | 固定清单 | 改用共用判定 |
| `session-repository.ts` `primaryRole`、`administration-service.ts` `permissionCatalog` | 主角色显示与权限目录 | 增加“模块管理员”显示与新增权限码 |
| `server/src/testing/test-identity.ts`、P0 冒烟数据 | 只有全权管理员身份 | 增加模块管理员测试身份 |
| `openapi-coverage.test.ts` | 校验 OpenAPI 覆盖 | 增加断言：`openapi-admin.json` 每条路径都在模块对照表中 |
| admin-web 路由与布局 | 全部 `requiredPermission: 'adminRead'` | 4.5 |

后台任务中需要“以管理员身份”执行的场景（如平台预置 Skill 创建专家时的 `findPlatformAdminActor`）不属于请求授权，继续使用平台管理员口径。

## 6. 文档同步

- [功能规则](../development/feature-rules.md)：新增“管理端模块权限”一节，写入权限矩阵、防提权规则与管理助手确认口径；
- [架构总览第 9 节](../development/overview.md#9-身份安全与数据边界)：补充管理端按模块校验；
- [数据模型第 1 节](data-model.md#1-租户身份与授权)：`roles.permissions` 可含模块权限码、部门授权按前缀禁止管理权限；
- [文档索引](../index/README.md)：登记本方案状态；
- E2E：新建 `e2e/catalog/admin-permissions.md` 分册并登记到 `e2e/TEST-CATALOG.md`。

## 7. 实施切片

| 切片 | 内容 | 完成标准 |
| --- | --- | --- |
| AMP-S1 | 共用判定函数与模块清单；路由对照表与默认拒绝；会话层准入；服务层 `requireAdminActor`；SQL 判定收敛；部门与 Agent 授权前缀规则与 AP5 上限；管理助手确认校验；选择器精简读取；测试身份与集成测试 | 模块管理员越权读写返回 403；现有全权管理员、审计员行为不变；OpenAPI 覆盖测试通过 |
| AMP-S2 | 管理端可点击原型 → 路由与菜单按模块控制、写按钮控制、权限选择分组、预置角色、E2E 分册与 spec | 原型确认；模块管理员只看到自己的模块；E2E 绿 |

## 8. 验收

- **P0：** 冒烟服务提供“知识库管理员”测试身份，登录管理端只看到企业知识库与可读页面，写其他模块被拒；
- **P1：** 一次性 PostgreSQL 上覆盖：模块读写 403/200 矩阵；部门授予管理权限被拒；Agent 管理员授予管理类角色或超出本人数据范围被拒；管理助手确认跨模块计划被拒；授权变更后下一次请求立即生效；
- **P2：** 本机真实 DSH 走查“Agent 管理员新建 Agent → 选择 Skill 与工具 → 验证 → 发布”与“管理助手安装 Skill（无 Skill 写权限时确认被拒）”。

## 9. 风险与未决

- **Session 摘要中的对话标题**属于员工输入片段，归入运营查看是否合适（AP6）；
- **选择器精简列表**需要逐个梳理跨模块引用，遗漏会导致页面空白而非越权，实施时以页面走查兜底；
- **对象级授权**（只管部分 Agent / 知识库）不在本期，若后续需要，可在模块权限之上叠加对象授权，不推翻本方案。
