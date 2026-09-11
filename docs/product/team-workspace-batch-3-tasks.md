# 批次 3 任务拆分与实施约束

**状态：** 进入批次 3 实施的任务边界（2026-09-11）。产品语义以 `team-workspace-plan.md` 为准，界面以 `team-workspace-design.md` 为准，本文件只拆任务、定验收与顺序。
**依赖：** 批次 1A（授权与撤权机制）、1B（团队资料与本人对话、文件与结果读取收权、可见统计基线）已交付。

## 范围决定（2026-09-11 产品确认）

**归档语义＝只读保留。** 团队空间归档后：

- **可读**：现任成员（含负责人）仍可按各自权限查看会话、文件、成果与历史运行，并下载有权限的内容；失去成员资格的成员仍然拒绝。
- **不可执行**：归档阻止新对话、续写、重试、上传、成员与 Agent 变更、空间设置修改；有排队或活动运行时不允许归档。
- 归档空间仍允许必要的**访问撤销与负责人治理**（不能以只读状态阻止紧急收权）；恢复不自动恢复已移除成员、不扩大授权。

这条语义与 `team-workspace-design.md` 的归档提示文案、方案 AC-14「历史按权限可读」一致。**注意**：1A 建立的实现口径是「团队空间必须 `status='active'`」这一条判断同时覆盖读与执行，因此 1B-T4 当时把归档统一成「一律拒绝」。批次 3 的第一个任务就是把这一个判断拆成**执行轨**与**读取轨**两条，并修正因此产生的测试与文档。

## 1. 现状核查（2026-09-11，代码级事实）

| 能力 | 现状 |
| --- | --- |
| 归档字段 | `workspaces.status`、`workspaces.archived_at` 已存在（`0001`），**无任何 API 写 `status='archived'`** |
| 读/执行口径 | 同一个 `w.status = 'active'` 判断同时约束读与执行，散落在 `workspaceTypeOf`、`resolveWorkspaceType`、`requireTeamRole`、`requireWorkspaceMembership`、`resolveAccessibleWorkspace` 五处 |
| `canReadWorkspaceObject` | 团队读门禁：`workspaceTypeOf` 为 null（含归档）即拒绝——**与本次只读保留决定相反，必须改** |
| 团队列表 | `listWorkspaces` 只返回 `status='active'`；`GET /workspaces` 的 `owner` 仍是**创建者**显示名且缺 `status`（1A 遗留，本批必修，否则归档态与负责人展示都不准） |
| 空间设置 | 前端仅有「归档空间」入口占位（设计 §2.7），未见 `PATCH /workspaces/:id`，说明/名称无法保存（1A 遗留） |
| 相关测试 | `team-workspace-authorization.integration.test.ts` 有一条断言「归档空间连 owner 也被 `requireTeamRole` 拒绝」——**该断言建立在旧语义上，需按只读保留改写** |
| TW-07/TW-08 | 文件版本、动态通知均未实现；`file_objects` 只有逻辑移除，无逻辑文件/版本关系 |

## 2. 任务单元

### 3-T1 归档语义：读/执行双轨授权 ✅ 已完成（2026-09-11）
- **目标**：把「`status='active'`」这一个判断拆成两条明确口径，作为 TW-06 其余任务与 TW-07/TW-08 可读性判断的基础。
- **执行轨（保持现状语义）**：新对话、续写、重试、上传、成员/Agent 变更、设置修改、转交要求**活跃团队 + 当前成员 + 平台授权**（取交集）；归档一律拒绝。
- **读取轨（本任务新增）**：会话、文件、成果、历史运行的读取与下载允许**归档 + 当前成员**；非成员与不存在空间仍然拒绝，且不可枚举（保持与「不存在」同文案）。
- **实现要点**：
  - 读路径不得再用 `workspaceTypeOf`（它只认 active）。新增状态无关的空间类型解析（如 `readableWorkspaceTypeOf`），或在读门禁里显式区分「归档」与「不存在」。
  - `canReadWorkspaceObject`（`authorization-errors.ts`）改为「团队 + 当前成员 ⇒ 允许（含归档）」；个人空间照旧。
  - `requireTeamRole` 增加「读用途允许归档」的显式选项；**默认仍要求活跃**，避免写路径被无意放宽。
  - `resolveAccessibleWorkspace`、`resolveWorkspaceType` 按调用方用途分别处理，逐个核对调用点，写路径必须保持拒绝。
  - SSE 建连与逐批写出走读取轨；执行前复核与排队领取走执行轨。
- **验收**：AC-14（归档语义部分）、AC-09（失权仍然拒绝）、AC-23（个人空间不变）。
- **风险**：读路径放宽后若写路径漏改一处，会出现「归档空间仍能执行」。必须逐个调用点列出用途并加回归测试。

### 3-T2 归档与恢复 API + 运行中并发保护 ✅ 已完成（2026-09-11）
- **接口**：新增空间状态变更（归档／恢复）；`GET /workspaces` 补 `status` 与 `archivedAt`，`owner` 改为**当前负责人**（`workspace_members.member_role='owner'`），不再用创建者。
- **规则**：仅负责人可归档／恢复；有排队或活动运行时拒绝归档并提示先等待或取消（不自动中断在途任务）；恢复清空当前归档时间、不恢复已移除成员、不扩大授权；归档／恢复写审计事件。
- **并发**：归档与「新对话／领取排队任务」必须串行化（空间行锁已在成员变更路径使用，沿用同一锁序），避免归档与开跑互相穿透。
- **列表**：`GET /workspaces` 支持活动／归档筛选（`status=active|archived|all`），**默认 `all`**（对齐设计 §2.1 与 §6 已确认决策「默认全部；个人空间恒显」——若默认 active，归档空间在 UI 里不可发现）。归档筛选只返回调用者仍有权访问的空间。
- **验收**：AC-14、AC-02 不受影响（转交不变）、AC-27（迁移不回归）。

**交付记录（2026-09-11）**：
- **接口**：`POST /workspaces/:workspaceId/archive`、`POST /workspaces/:workspaceId/restore`（`workspace-lifecycle-routes.ts`）；`GET /workspaces?status=active|archived|all`（**默认 `all`**，对齐设计 §2.1/§6「默认全部；个人空间恒显」；`archived` 供 3-T3 归档筛选）。服务层默认同步为 `all`，`createWorkspace` 显式按 `active` 查回新空间。
- **实现位置**：`postgres-workspace-lifecycle-service.ts`（负责人校验、状态变更、审计、运行中拦截）、`workspace-state-conflict-error.ts`（类型化 409，避免按文案分类）、`router.ts`（类型化 409 映射）、`postgres-content-service.ts`（列表 `status`/`archivedAt`/当前负责人/筛选）、`postgres-run-repository.ts`（开跑／重试／领取的空间行锁兜底）。
- **锁序（唯一空间锁）**：`workspaces` 行锁 → `sessions` / `run_attempts` / `runs` / `runtimes`。归档事务首语句 `select ... from workspaces for update`；`createRun` / `createAttempt` / `claimAttempt` 的首语句同样先锁 `workspaces` 行（与成员变更、授权来源清扫同一把锁），因此归档与开跑/领取串行：归档先提交则开跑/领取被拒（typed 403 / `claimAttempt=false`），开跑先提交则归档因存在活动 Run 被拒（409）。无第二把空间锁。
- **锁序修正（质量评审 F2，既有死锁）**：原先 `owner-transfer` 先锁 `workspaces`，而 `addMember`/`changeMemberRole`/`removeMember`/`exitWorkspace` 先改 `workspace_members`、最后才 `update workspaces`（`bumpTeamAuthRevision`），形成**反向锁对**；并发转交 + 移除成员实测 40 次里 39 次 `40P01 deadlock detected`，并被 HTTP 分类成 **500**。现四个成员变更入口统一经 `runMembershipMutation` **先取空间行锁**，锁序全局一致。新增回归用例（8 轮并发转交 + 移除，断言无 deadlock 且至少一方成功）并反证：去掉该锁即变红。
- **排队期间归档的收敛（质量评审 F3）**：归档空间里遗留的 queued attempt（历史/迁移/外部写入，API 路径不可达）原先会让调度器每 500ms 无限重排（实测 2.6s 内 6 次、永不收敛）。现 `claimAttempt` 失败且 attempt 仍 queued 时，用 `RunRepository.workspaceStatusForAttempt`（attempt→run→session→workspace 关联）判断归档，收敛为终态并落 `run.failed` 说明事件。已加判别性用例并反证。
- **`{}` manifest 加固（验证代理 D1；初版此处声明有误）**：初版交付记录写「不读 manifest——夹具/历史的 `manifest` 列可能是 `{}`」，该表述**只对了一半**：判断归档确实不读 manifest，但调度器**取 attempt id 仍读 `manifest.attempt_id`**；遇到 `{}` 会把 `undefined` 绑进 SQL → `UNDEFINED_VALUE`，并经 `void this.pumpScheduler()` 变成未处理 rejection（进程级致命，run/attempt 永远 queued）。现回退到 run 的权威指针 `currentAttemptId`，两者都没有则跳过并告警，绝不把 `undefined` 传给仓储。
- **成员变更的锁内状态复核（验证代理 D4，既有 TOCTOU）**：成员新增/改角色/退出的空间状态原先只在**事务外**检查；归档若在其等待行锁期间提交，变更仍会成功（强制时序实测 8/8 穿透）。现状态复核随行锁移入事务内；`removeMember`（紧急撤权）与 `transferWorkspaceOwner` 作为治理例外显式传 `allowArchived`，归档空间仍可执行。已加判别性用例并反证。
- **归档拒绝文案与状态**：`该空间还有 N 个排队或运行中的任务，不能归档；请等待任务完成或先取消任务` → 类型化 `WorkspaceStateConflictError`（409 `state_conflict`）。个人空间归档/恢复 → 422（AC-23 团队专用接口惯例）。非负责人/非成员 → `authorizationDenied(...)` → 403。
- **恢复语义**：仅清 `archived_at` 并置 `status='active'`，不触碰 `workspace_members`；已移除成员保持移除，授权不扩大。归档空间仍可执行紧急撤权（`DELETE /members/:userId`）与负责人转交（3-T1 治理例外，未改动）。
- **测试**：新增 `server/src/http/team-workspace-lifecycle-api.integration.test.ts`（**18 个用例**，`createThrowawayDatabase()`），登记为 `test:m5:lifecycle:integration`（`server/package.json`、根 `package.json`、`.github/workflows/ci.yml`）。
- **反证声明的更正（规格评审 P1 / 质量评审 F1）**：初版曾声称「去掉 `createRun`/`createAttempt`/`claimAttempt` 的空间行锁…对应用例均变红」——**该声明不成立**：两轮评审各自实测「削掉三处 `for update of w`、保留归档状态判断」后套件仍 14/14 全绿，说明原有用例只证明「状态判断存在」，不证明「行锁存在」，即一个带 TOCTOU 的错误实现能通过 CI。现补两条**能区分有锁/无锁**的用例：① 外部事务持有空间行锁时开跑不得推进（无锁则会立即完成）；② 转交 + 移除成员并发无死锁。两条均反证过（削弱实现即变红）。运行中拦截、当前负责人解析的反证仍然有效。
- **契约**：`docs/contracts/openapi-workbench.json` 补 `status` 筛选参数与两个新端点（含 409 说明）。
- **未做/超出本任务**：`PATCH /workspaces/:id`（名称/说明保存）仍缺，属 3-T3 依赖的 1A 遗留；前端归档体验为 3-T3；无新增迁移（复用 `0001` 的 `status`/`archived_at` 与 `audit_events`）。

### 3-T3 前端归档体验 ✅ 已完成（2026-09-11）
- 空间列表：`全部／活动／已归档` 紧凑筛选（口径见 3-T2），归档卡片显示「已归档」状态标记；计数文案随筛选变化。
- 归档空间详情：页头下只读提示条 + 负责人可见「恢复空间」；隐藏新增对话、续写、上传、重试入口。判定依据是服务端返回的 `status`（归档）与 `currentUserRole`（负责人），前端不按创建者/姓名推断；注意 workspace 级**没有** `allowedActions` 字段（该字段只存在于 Agent 成员对象），不要按它渲染空间级动作。
- 空间设置弹窗：补名称/说明保存（依赖 `PATCH /workspaces/:id`）、归档二次确认与运行中冲突提示、退出空间提示（贡献保留）。
- 只读成员与归档态的组合：只读成员在归档空间仍可查看与下载，不显示任何写入口。
- **验收**：AC-14（前端部分）、AC-16（状态可验证）、AC-23（个人空间不显示上述入口）。

**交付记录（2026-09-11）**：
- **列表筛选（design §2.1/§6）**：`WorkspacesView.vue` 增加 `全部/活动/已归档` 分段筛选，状态写入路由 `?status=active|archived`（默认「全部」不带参数，沿用 `?view=history` 深链写法）。非「全部」结果单独持有，不覆盖全局 `contentStore.workspaces`——避免筛选把个人空间从其它页面（默认空间、详情回退）移除，守住 AC-23。归档卡片追加 `StatusTag status="warning"`「已归档」且仍可点击进入只读详情；归档空态为「暂无已归档的团队空间」。
- **归档只读详情（design §2.7/§3）**：`WorkspaceDetailView.vue` 页头下新增只读提示条「该空间已归档，仅保留有权限的只读查看与下载」，`恢复空间` 仅当服务端 `GET /workspaces/:id/members` 的 `currentUserRole === 'owner'` 时渲染。归档时隐藏新对话（`ConversationStarter`）、对话视图切换、上传按钮与「引用到对话」，对话页签固定展示历史；会话、文件、成果与历史仍可读/可下载。`WorkspaceSessionHistory.vue` 增加 `archived` 空态，避免归档时误显示「联系负责人添加可用 Agent 成员」。
- **会话页续写/重试（design §2.7）**：`ConversationView.vue` 按运行所属团队空间的 `status`（服务端返回）隐藏续写输入（TaskComposer）与两处「重新执行本轮」，改为只读提示；个人空间分支不命中（AC-23）。
- **空间设置（design §2.7）**：`WorkspaceSettingsDialog.vue` 的名称/说明保存改调 `PATCH /workspaces/:id`，清空说明显式传 `description: null`；移除「保存接口未就绪」占位文案。新增「归档空间」区（负责人、二次确认）与归档态「恢复空间」区；归档被在途任务拒绝时（409 `state_conflict`）在弹窗内行内展示服务端给出的任务数量与「请等待任务完成或先取消任务」。
- **API 与类型**：`src/api/client.ts` 新增 `updateWorkspace`、`archiveWorkspace`、`restoreWorkspace`，`getWorkspaces(status)` 支持 `?status=` 筛选；`src/types/domain.ts` 收紧 `Workspace.status` 为必填并补 `archivedAt`，新增 `WorkspaceStatus`/`WorkspaceStatusFilter`/`WorkspaceLifecycleResult`/`WorkspaceUpdateInput`。
- **测试**：新增 `WorkspacesView.test.ts`（7）、`ConversationView.test.ts`（3），扩展 `WorkspaceDetailView.test.ts`（18）、`WorkspaceSettingsDialog.test.ts`（13）、`api/client.test.ts`（21）。关键判别性用例经反证：归档标记、隐藏新对话、`恢复空间` 仅负责人、`description: null`、409 行内提示、会话页归档只读——削弱实现即变红。
- **未做/超出本任务**：本机无浏览器 e2e（OIDC 允许来源限制，见 1B 任务 §3.1），未运行 `pnpm test:e2e`；无新增迁移。
- **服务端改动（本工作区一并交付）**：3-T3 依赖的 `PATCH /workspaces/:id`（团队空间名称/说明保存，1A 遗留）由本工作区补齐 —— 路由、`updateWorkspace` 服务方法（空间行锁内复核「活跃 + 负责人」）、OpenAPI 路径与集成用例；无迁移。


**评审修复（2026-09-11）**：
- **筛选 tablist 无键盘支持**（符合性评审 F1，硬伤）：roving tabindex 只让当前项可 Tab，未实现方向键，键盘用户永远切不到「活动/已归档」——违反 §4 与 AC-16。已实现 ArrowLeft/ArrowRight/Home/End + 聚焦选中项，并补键盘用例。
- **PATCH 空请求体返回 500**（F2）：契约只声明 200/403/422，空 body 与超长名称原先靠文案分类落到 500。新增类型化 422（`requestInvalid`，放在 `authorization-errors.ts`，避免应用服务反向依赖 http 层的 `routeValidationFailed`），并补断言。
- **前端纵深防御**（F3）：`archived` 筛选结果若意外含个人空间，原先会渲染出来。现仅对「已归档」过滤非团队项（注意「活动」视图里个人空间合法，不能一并过滤——初版就是这样写的，被既有用例当场抓住）。
- **筛选重复请求**（F4）：点击改路由又直接加载，真实路由下每次切换发两次同参请求。已加同参去重，同时保留点击与深链两条加载路径。
- **文档机制描述失实**（F5）：原写「写入口隐藏由服务端 `allowedActions` 给出」，但 workspace 级没有该字段（只有 Agent 成员有）；实际依据 `status` + `currentUserRole`。已更正。
- 另补：PATCH 与归档抢空间行锁的判别性用例（原仅注释声称靠行锁防 TOCTOU）。

**质量评审修复（2026-09-11，写入口审计）**：评审按「归档空间里还有哪些写入口可点」逐项审计，抓出详情页之外的四处遗漏，均已修复并各配判别性用例（削弱实现即变红）：
- **P1 成员/Agent 管理弹窗仍可点击**：`WorkspaceMemberDialog` 原无 `archived` 概念，归档空间里「添加员工/改角色/添加 Agent/停用/升级/移出/开始对话」全部可点（服务端 403，纯死路）。现按归档隐藏全部写入口，**保留移除成员**（紧急收权，服务端 allowArchived 的治理例外）。注意「移除」原先被写在角色编辑的同一 `template` 里，第一版门禁把它一起藏了——已按治理例外拆出。
- **P2 全局新对话空间选择器列出归档团队空间**：`ConversationStarter` 现只把「个人空间 + 活动团队空间」交给 composer。
- **P2 侧栏「删除对话」未按归档禁用**：会话删除属执行轨。判定抽成 `utils/archived-workspaces.ts` 的纯函数（只依赖服务端 `type`/`status`，空间未加载时不误禁用），并补单测（含 AC-23：活跃团队与个人空间仍可删）。
- **P2 筛选请求失败后仍显示上一个筛选的陈旧卡片**：现失败即清空结果、进入错误态并提供「重试」，且去重记账只在成功后写入（否则失败会被误记为「已加载」而无法原地重试）。
- **P3/P2 契约与文档**：PATCH 的 `200` 改用共享 `Ok`、名称补 `minLength/maxLength`、去掉未强制执行的 `additionalProperties:false`；JSON `null` 请求体现在显式 422（原为 500）；更正交付记录中「未改服务端」的自相矛盾与 `allowedActions` 的失实描述；`WorkspaceInfoPanel` 的过期注释同步。

### 3-T4 批次 3 集成验证与 CI 接入 ⬜ 未开始
- 新增/扩展集成套件：归档读/执行双轨、运行中归档拒绝、并发归档与新开跑、恢复语义、列表筛选与负责人展示。
- 真实 DSH 端到端补一条：归档后历史运行可读、新运行被拒。
- 新套件按 1A/1B 约定用 `createThrowawayDatabase()`；需要时在 `server/package.json`、根 `package.json`、`.github/workflows/ci.yml` 三处登记。
- **验收**：批次 3 全部验收项在 CI 门禁内有锚点。

### 3-T5 文档与退出条件收尾 ⬜ 未开始
- 更新方案 §6.4/§6.5/§10、设计 §2.1/§2.7 与 handoff，记录归档语义的最终口径与实现位置。
- 明确 TW-07／TW-08 的相对顺序（本批先交付 TW-06；两者依赖已交付的读取轨判定）。
- **验收**：`pnpm verify` 的文档与契约检查通过；1B 遗留的归档语义待定项关闭。

## 3. 顺序与依赖

```
T1（授权双轨）──> T2（归档/恢复 API）──> T3（前端体验）
                        │
                        └──> T4（集成验证与 CI）──> T5（文档收尾）
```

- T1 必须先做：T2 的归档写入一旦落地，读/执行口径必须已经分开，否则归档会立刻造成过收权（连只读都读不到）。
- 每个任务：实现（TDD 先红后绿）→ 规格符合性评审 → 质量评审 → 修复 → 复审，流程同 1A/1B。

## 4. 贯穿约束（违反即回退）

- **个人空间零改动（AC-23）**：双轨判断只作用于团队分支；个人空间接口、页面与授权路径保持现状。
- **不能以只读状态阻止紧急收权**：归档后仍必须能执行撤销访问、转交负责人等治理动作（执行轨的例外要显式列出并加测试）。
- **新增授权拒绝统一抛 `authorizationDenied(...)`**，不要依赖文案分类。
- **API 变更必须同步 OpenAPI 契约**并跑 `pnpm verify`；不得绕过 DSH 另建 Agent 执行逻辑（AGENTS.md）。
- **新增集成套件必须用 `createThrowawayDatabase()`**，不得直连共享库。
- `DSH_WORK_TEST_DATABASE_URL` 需显式传入（`.env` 未配置）：`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。
- 本机 `pnpm test:e2e` 因 OIDC 允许来源只含 `localhost` 而失败（非缺陷），CI 不受影响；详见 `team-workspace-batch-1b-tasks.md` §3.1。

## 5. 已知遗留（进入本批一并处理）

- `GET /workspaces` 的 `owner` 仍是创建者显示名且缺 `status`（3-T2 修）。
- 缺 `PATCH /workspaces/:id`（名称/说明保存，3-T3 依赖）。
- Agent「不可用」第三态与具体原因未落地；员工名册无 `department`（与批次 3 无直接依赖，可另立小任务）。
