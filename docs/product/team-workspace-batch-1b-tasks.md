# 批次 1B 任务拆分与实施约束

**状态：** 进入 1B 实施的任务边界（2026-09-11）。产品语义以 `team-workspace-plan.md` 为准，界面以 `team-workspace-design.md` 为准，本文件只拆任务、定验收与顺序。
**依赖：** 批次 1A 已交付（授权来源多对多、撤权事件、执行前复核、系统取消、SSE 与 REST 读取拦截）。

## 1. 现状核查（2026-09-11，代码级事实）

| 能力 | 现状 |
| --- | --- |
| 团队 Session 分页 | **不存在**。`listTasks(userId)` 只返回本人最近 50 个 Run，无 workspace 维度、无游标、无 Session 去重 |
| Session 索引 | 已有 `sessions_by_workspace (tenant_id, workspace_id, last_active_at desc)`，可支撑团队分页 |
| 来源限制 | **完全未实现**：全仓无字段、无采集、无投影 |
| 文件列表/下载/移除/搜索 | **不存在**。仅有上传与「引用到对话」（`prepareRuntimeFiles` 走不可变 `file_objects`） |
| 前端对话页签 | 无「新对话／历史对话」切换，无历史视图 |
| 文件/结果收权 | 1A 已覆盖 SSE 与 Run 详情/列表/取消读取，**未覆盖文件下载与结果读取** |

## 2. 任务单元

**实施记录（2026-09-11）：** T1 与 T3 已交付并接入 CI（`test:m5:sessions:integration`、`test:m5:shared-files:integration`）。**范围口径已确认**：`scope=mine`（默认）为 1B 的本人历史列表，`scope=team` 留给 2A 的「团队共享」；T3 的移除是逻辑移除（对象/解析结果/历史 Run 引用保留）。

### 1B-T1 团队 Session 分页 ✅ 已完成（后端 `43cfc28`/`d894322`、前端 `49976e7`/`8389fec`）（方案 §6.2「会话列表」、§6.3「Session 查询」、§6.6）
- 服务端接口：按空间分页返回 **Session 摘要**（不含正文）：稳定 Session 身份、标题、发起人、最近活动时间、最新 Run 指针与状态、Run 计数；游标分页、标题关键词过滤、固定「最近活动倒序」。
- 权限：仅当前团队成员可读；按授权结果**先过滤再分页与计数**（不先取全量再在应用层裁掉）。
- 前端：对话页签顶部「新对话／历史对话」segmented，写入 `?view=history`；历史视图含搜索框、列表行（状态点/标题/发起人/最近活动/最新状态）、「加载更多」与「已加载全部」、三种空态（设计 §2.2）。**「我的对话／团队共享」与发起人筛选属 2A，不渲染空入口。**
- 索引：按实际查询计划补 `(tenant_id, workspace_id, last_active_at desc, id)` 类索引（若既有索引不足）。
- 验收：AC-05、AC-06；>50 Run 的会话仍能在团队分页中找到其他会话。

### 1B-T2 来源限制采集（未开始）（方案 §6.3 第三段）
- 为团队输入文件、知识上下文、工具返回数据记录**可追溯来源标识**与**访问限制**，并随结果保存；**缺失限制记为「不可判定」**，不得默认放行或默认拒绝。
- 数据模型：在 1A 的 `workspace_grant_sources` 之外新增「来源限制」维度（迁移 `0024`），保持不可变快照语义。
- 约束：这是 2A 派生与撤回的**前置**；本批只做采集与随结果保存，不做派生传播。
- 验收：AC-07 的「输入与结果可追溯来源限制」；不可判定项有明确标记与可观测证据。

### 1B-T3 共享文件：下载、搜索、逻辑移除 ✅ 已完成（`61d0a07`/`dfeb1f1`/`963bf61`）（方案 §6.2「文件列表、详情与管理」、设计 §2.3）
- 服务端：按空间列出文件（名称搜索、分页、状态、上传人、时间）、下载（沿用不可变对象）、负责人/管理员或上传人本人的**逻辑移除**；旧 ID 下载不能绕过移除与权限。
- 权限：只读成员不渲染上传与移除（保留引用与下载）；成员仅对自己上传的文件可移除。
- 迁移：逻辑移除字段（不复用、不覆盖 `file_objects` 与解析结果）。
- 验收：AC-13 的「移除阻止新引用、历史 Run 仍可追溯实际版本」；下载鉴权与个人空间行为不变。

### 1B-T4 文件与结果读取收权（部分完成：文件侧已随 T3 落地，见下）（方案 §6.5 第 3 条尾句、AC-09）
- 把 1A 的团队读取校验扩展到：文件下载、文件详情、结果读取（Run 事件/正文已在 1A 覆盖，此处补齐文件侧）。
- 断线续传与已建立订阅的失权行为沿用 1A 机制，不新造第二套。
- 验收：AC-09「失去读取资格时文件下载、详情、搜索…均被拒绝」。

### 1B-T5 可见统计性能基线（未开始）（方案 §6.6）
- 建立含多成员、多会话、单会话 >50 Run 的数据基线，记录查询计划、延迟分位数、数据量与并发。
- 产出一份可复核的基线记录；不预设物化方案。

## 2.1 真实 DSH 端到端验证结果（2026-09-11，已完成一次）

`scripts/runtime/team-workspace-e2e.ts`（一次性库 + 真实 `DshAcpRuntimeAdapter`）实测 `ok: true`：

- A 上传 `e2e-inventory.md` → 共享文件列表可见、`scanStatus=clean`、不可变对象 + 解析结果落库；
- 团队 Agent 成员关联走**真实服务**（同时建立 Agent/Skill/Tool 授权来源）；
- **B（成员）**发起团队会话并引用该文件运行 → `succeeded`，助手回复**回显了文件内的标记**（证明文件内容真实进入 DSH 执行）；
- 运行完成后**继续对话** → 第二个 Run `succeeded` 且仍能回显标记（满足 1B 退出条件「并能继续」）。

**真实 DSH 事件与来源落点（T2 设计依据）：**

| 观察 | 值 | 对 T2 的含义 |
| --- | --- | --- |
| 事件类型 | `run.queued/started`、`approval.required/resolved`、`assistant.delta/completed`、`run.completed` | **没有 tool 事件**；无 `tool.*` 事件类型 |
| 工具调用痕迹 | `approval.required` 的 `safe_metadata` 带 `tool_name='read'`、`tool_call_id`、`option_kinds` | 工具来源信息来自**审批事件**，不是 tool 事件 |
| 工具审计 | `tool_audit_logs` 落 1 行：`tool_version_id='tool-version-read-1'`、`parameter_summary={decision,tool_name,tool_call_id}`、`result='success'` | 工具来源可从 `tool_audit_logs` 关联到 Tool Version |
| 工具返回值 | 审计只记参数与决策，**不记结果内容** | 若 T2 要追溯「工具返回了哪些数据」，现有链路缺少该落点 |
| 文件来源 | 来自 `run_input_files` + attempt manifest 的 `input.file_mounts` | 文件来源可由此关联到不可变 `file_objects` |
| 知识来源 | manifest 的 `knowledge_context`（含 `documentId/version/dataScope/contentChecksum`） | 知识来源已随不可变 Manifest 固化，可直接扩展限制字段 |

**运行环境提示（本轮踩到）：** `pnpm probe:*` 原先不加载 `.env`，会按生产档（`0.1.2-rc.1`）比对本地开发档（`0.1.1-rc.2`）并 fail-closed 报 version mismatch；已修（`c196c82`）。本地/生产**双档并存**是刻意设计（`runtime-lock.json` 的 `compatibility` + `DSH_RUNTIME_COMPATIBILITY`），不是版本落后。

## 3. 顺序与依赖

```
T1（Session 分页） ─┐
T3（文件能力）   ─┼─> T4（文件/结果收权，依赖 T1/T3 的读取面）
T2（来源限制采集）─┘        └─> T5（性能基线，需要 T1 的查询与数据量）
```

- T1 与 T2/T3 可并行；T4 必须在 T1/T3 之后。
- 每个任务：实现（TDD 先红后绿）→ 规格符合性评审 → 质量评审 → 修复 → 复审，流程同 1A。

## 4. 贯穿约束（违反即回退）

- **个人空间零改动（AC-23）**：团队分页、来源限制、文件能力与收权只在团队分支生效；个人空间接口与页面保持现状。
- **新增集成套件必须用 `createThrowawayDatabase()`**（`server/src/infrastructure/postgres/test-database.ts`），不得直连共享库。
- **新增授权拒绝统一抛 `authorizationDenied(...)`**，不要依赖文案分类。
- **API 变更必须同步 OpenAPI 契约**并跑 `pnpm verify`；不得绕过 DSH 另建 Agent 执行逻辑（AGENTS.md）。
- 团队读取边界继续用不依赖当前成员身份的 `workspaceTypeOf` 判定空间类型。
