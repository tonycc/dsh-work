# 团队工作空间实施交接文档

**交接时间：** 2026-09-10  
**分支：** `feat/team-workspace`（基于 main @ 404f885，共 13 个提交，未推送远端）  
**目的：** 供接手的其他 agent/会话从此状态继续批次 1A 剩余工作。本文是当前进度的事实快照；产品语义以三份产品文档为准。

## 1. 文档地图（必读顺序）

| 文档 | 角色 |
| --- | --- |
| `docs/product/team-workspace-plan.md` | 唯一方案入口：范围、TW-01~09 产品规则、权限矩阵、批次与退出条件、验收矩阵 AC-01~29 |
| `docs/product/team-workspace-design.md` | 批次 0 UI 增量设计（已确认 5 项决策，第 6 节） |
| `docs/product/team-workspace-batch-1a-convergence.md` | 1A 四项技术收敛草案 + 已确认决策（授权来源模型、负责人约束、收权机制、Agent 允许范围） |

## 2. 进度快照

| 阶段 | 状态 | 关键提交 |
| --- | --- | --- |
| 批次 0 设计收敛 | ✅ 完成、已确认 | `feae774` |
| 1A-T1 数据库迁移 | ✅ 双评审通过 | `aebab9f` 迁移、`c3dfb70` 修复 |
| 1A-T2 授权层 | ✅ 双评审通过 | `a39a560`、`aaf10e9` 修复 |
| 1A-T3 员工成员 API | ✅ 双评审通过 | `35b9fc2`、`b5ca093` 修复 |
| 1A-T4 Agent 成员 API | ✅ 双评审通过 | `eb28e47`、`3f897f1` 契约修复 |
| **1A-T5 收权链路** | ✅ **实现完成、两级评审已修**：`f45686b` + `8a95574`/`94d1ddd` + 评审修复；`pnpm test:m5:revocation:integration` **21/21 且连续多次稳定**，`test:m5:revocation`（分类器单测）接入 `ci:check` | `f45686b`、`8a95574`、`94d1ddd`、`b20a675`、`912497c`、`279e540`、`97b7c5e` |
| **1A-T6 前端成员管理** | ✅ **实现完成、规格评审已修**：`a2a83ed`..`f16fb8c` 六个提交 + 对接修复 `462bfbb`/`dddc794`；`pnpm test:m5:frontend` **workbench 85 / admin 18 全绿** | `a2a83ed`、`2558908`、`db2e016`、`5f9cb67`、`1f2c226`、`f16fb8c`、`462bfbb`、`dddc794` |
| **1A-T7 对账清单与迁移验证** | ✅ **实现完成、规格符合性 + 质量评审已修**：6 个提交 + 锁序/基线修复；reconciliation 8/8、upgrade 4/4、migration 10/10 | `09800d0`、`73578d6`、`27507bb`、`1fab46a`、`272fd10`、`2a09842`、`769fad9`、`a85b703` |
| 1A 合并与 CI 接入 | ✅ `main` 已含 1A 并推送；6 个团队集成套件接入 CI 门禁，`M6 quality gate` 通过 | `bf9d58c`、`7d49c74`、`55da0d7` |
| 测试基础设施 | ✅ 全部 **21 个**集成套件改为一次性库（`test-database.ts` 的 `createThrowawayDatabase()`），消除共享库污染 | `c97db7b`（未推送） |
| **1B 团队资料与本人对话** | 🚧 **启动**：TW-03 本人历史列表、TW-05、团队 Session 分页、来源限制采集、文件／SSE 收权、可见统计性能基线 | — |
| 2A / 2B / 3 / TW-09 | ⬜ 未开始 | — |

**T6/T7 评审结论与关键技术结论（2026-09-10）：**

- **T6 规格评审：有条件符合 → 已修。** 核心发现：实现者把「员工成员管理不可用」归因为后端缺口，但事实是 **`GET /workspaces/:id/members` 在 T3 就不存在**（我核实：`workspace-member-routes.ts` 有候选/增/改/删/退出/转交，**无读取名册**）。我补齐了 `listMembers`（返回名册 + 调用者 `currentUserRole`）+ 契约 + client 方法（`462bfbb`），并把视图接线到该接口、以服务端角色取代按「创建者姓名」推断（`dddc794`）——转交负责人后新负责人不再失去写入口。AC-23 由评审代理**独立**对 10 个团队 API 下 spy 验证通过。
- **T7 规格评审：符合；质量评审：有条件合入 → 已修。** 实证缺陷 D1：`reconcile` 与 Agent 移出**锁序相反**（来源行→workspace 行 vs workspace 行→来源行），PostgreSQL 报 `deadlock detected`；已统一为「先 workspace、后来源」并加并发回归测试（`769fad9`）。D2 取消对账误报错误、D3 基线检查未按表限定（同名对象可误通过）已修（`a85b703`）。
- **AC-27 独立验证**（评审代理自建场景）：运行完整迁移链后删除 `one_personal_workspace_per_user` 再重跑 → 0022 被中止且 `schema_migrations` 无 0022/0023 记录，无半升级。
- **0013 触发器 personal→team 不校验旧空间**：确认为真实缺口，本批次按 plan 6.4「不得改写个人空间保护触发器」只记录决策、不修（见 `0022`/convergence §5），后续批次用独立迁移扩展。

**合并前外部审查（main...feat/team-workspace）修复记录（2026-09-10）：**
审查基线为 `main(404f885)...feat/team-workspace(3b335e5)`，结论「不建议合并，权限闭环与普通成员入口有缺口」。六项已全部修复并各有回归测试（提交 `92ace62`、`b2d50f4`、`20121ca`、`5b5ccd3`）：
1. **P1 收权只覆盖 SSE，REST 读取仍可读。** 被移出成员的 `GET /runs/:runId` 仍 200 返回正文、`/tasks` 仍列出该运行。两个路由接入与 SSE 同一口径（不依赖成员身份判定空间类型 + `authorizeTeamReadAccess`）：详情 404、列表剔除；个人/standalone 不受影响（AC-23）。
2. **P1 执行鉴权未独立校验 Agent 成员可用性。** 对账把 legacy 来源改写为 `manual` 后，停用成员不会撤销该 grant，`authorizeTeamRunExecution` 仍放行，既有会话可续写/重试。新增按 `agent_version_id` 的成员可用性校验；无关联的升级前固定版本授权保持可用。
3. **P1 普通成员没有可达的 Agent 选择入口。** `presetAgentMember` 只能从仅负责人/管理员可见的成员弹窗设置，右栏 Agent 条目不可点 → 普通成员提交时关联 ID 为 `undefined` 被后端拒绝。右栏可用 Agent 条目现提供「开始对话」并对所有成员可用；同时在未选中可用 Agent 时于输入区阻止提交并给出引导（`requiresAgentMember` 仅团队为真，个人路径不变）。
4. **P1 空间锁内未复核操作人角色。** 负责人检查在事务外，转交并发提交后旧负责人仍能写入成员与授权。新增在持有 workspace 行锁的事务内复核（add/disable/enable/upgrade/remove 五处）。
5. **P2 加入接口未复核 Agent 角色可见范围。** 候选查询按 `visible_role_ids` 过滤只是展示，直接提交 ID 仍返回 201。写入前按添加人当前角色复核（`assertAgentVersionVisibleToRoles`）。
6. **P2 并发对账测试假设对账先获锁。** `Promise.all` 不保证顺序：移出先持锁时门禁返回 409 是正确行为。改为接受两种顺序（移出被 409 后在对账完成时重试），仍断言不得死锁。

**第二轮外部复审（`3b335e5..3ff26b2`）修复记录（2026-09-10）：** 复审仍判「不建议合并」，报 5 项（3×P1、2×P2），已全部修复并有回归测试（提交 `5541b58`、`f6223eb`、`c9a017f`）：
1. **P1 升级后旧版本会话漏检成员状态。** 原先按成员**当前** `agent_version_id` 匹配：Agent v1→v2 升级后成员行指向 v2，v1 会话查不到关联被当作「升级前无关联」放行。改为通过**版本所属 Agent** 定位成员，再校验状态（成员可用时旧版本仍可执行）。
2. **P1 新增授权拒绝未接入撤权分类器（与上一条同源）。** 新错误不匹配 `isAuthorizationDenial` 的文案列表：重复停用（事件被去重、走修订号清扫）时被当作基础设施故障，运行未被取消，且修订号被记为已处理。根因是「按中文文案判定授权结果」；已引入类型化 `AuthorizationDeniedError`（status 403），路由按类型映射 403，清扫器按类型识别。**后续新增授权拒绝应抛 `authorizationDenied(...)`，不要再依赖文案。**
3. **P1 取消接口仍可绕过读取限制。** `POST /runs/:runId/cancel`（与 `retry`）返回完整正文，被移出成员可借其读回回答。二者现应用与详情/列表相同的团队读取校验（不通过则 404）。
4. **P2 新入口忽略只读成员允许动作。** 右栏「开始对话」原先只判断 `available`，导致服务端 `allowedActions=[]` 的 viewer 也看到入口并能解除输入区限制。现按 `allowedActions` 含 `start_conversation` 渲染，`ConversationStarter` 的阻止逻辑也改为由该集合驱动（入口、选择、提交三处一致）。
5. **P2 可见范围拒绝被映射为 500。** 越权加入已能拒绝，但普通 `Error` 文案不匹配路由权限分类 → HTTP 500。类型化错误修复后为 403 `permission_denied`，并补了 POST 接口断言。

**已确认的两处设计口径（外部复审确认，勿改）：**
- **类型化授权错误**：新增授权拒绝统一抛 `authorizationDenied(...)`（`AuthorizationDeniedError`，status 403），同时满足撤权清扫器识别与 HTTP 403 映射。**本轮只迁移新增的两处**；旧文案列表 (`LEGACY_DENIAL_MESSAGES`) 作为回退保留，属后续技术债，不要求本轮全量迁移。
- **可见范围按平台角色判定**：加入 Agent 成员必须**同时**满足「空间负责人」（`requireActorRole`，且在 workspace 行锁内复核）与「平台角色符合该 Agent 的 `visible_role_ids`」（`identity.roleIds`）。两者职责不同，**不要**把可见范围改成按空间员工角色判定：
  - 平台角色决定「该员工是否获准使用/加入这个 Agent」；
  - 空间角色决定「该员工能否管理当前空间的 Agent 成员」。
  这保证候选查询（同样按 `sessionAuthorizationContext(identity).roleIds` 过滤）与提交校验口径一致。

**T6/T7 已知遗留（不阻断 1A 退出条件）：**
- Agent「不可用」第三态与具体原因未落地：服务端 `AgentMemberRecord` 不返回 `unavailableReason`，前端红点与 tooltip 因此永不显示（design §2.6）。需服务端补原因码，属后续小任务。
- `GET /workspaces` 的 `owner` 仍是**创建者**显示名（非当前 owner）、缺 `status`，故右栏负责人展示与归档态在契约补齐前不准确。
- 员工名册未返回 `department`（design §2.6 期望「姓名+部门」）；`PATCH /workspaces/:id`（名称/说明更新）缺失，设置弹窗保存只提示未提交、不伪造成功。
- 平台级「停用工具」未加对账门禁（T7 决策：属平台治理，1A 唯一破坏性路径是 agent_member 撤销）。

## 3. T5 收权链路（实现完成、两级评审已修）

`f45686b` 是被打断的实现代理留下的 WIP，含：`run-revocation-sweep.ts`（新）、`systemCancelRun`、`cancelCause='system_revoke'`（runtime adapter + types）、execute 前复核、SSE 团队分支逐批写出检查、新测试文件 `m5-revocation-pipeline.integration.test.ts`。

**验收状态（2026-09-10）：** `pnpm test:m5:revocation:integration` **18/18 通过且连续 10 次稳定**；`typecheck` / `pnpm verify` / `pnpm lint` 通过。规格符合性与对抗性质量评审各一轮，发现项均已修或有明确排期。

WIP 首次运行是 **16 个用例 8 失败**，修复分两类：

**产品缺陷（均已修 + 有回归测试）：**
1. **幽灵态 running 永久卡死。** 调度器 `claimAttempt` 在调用 Runtime **之前**就把 `runs.status` 置为 `running`，而 Runtime 适配器此时还没有执行记录。撤权落在该窗口时 `runtime.cancel` 返回 `accepted:false`，旧 `systemCancelRun` 只处理 `queued` 分支，run 永久停在 `running`。修复：`queued`/`running`/`cancel_requested` 三态统一走 `convergeCancelledRun` 库内收敛。
2. **`cancel_requested` 无收敛兜底（质量评审 D3）。** 该状态非终态，但适配器对二次取消返回 `accepted:true`，一旦终结事件丢失就永久滞留。已并入上面的收敛集合。
3. **事件序列双写者竞态（规格+质量评审一致定位，flaky ~40%）。** 适配器按自身计数器定 `sequence`，系统说明事件按 `max(sequence)+1` 定，两者撞 `run_events_tenant_id_attempt_id_sequence_key`；写入失败会连带丢失该事件的状态迁移副作用（`run.cancelled`/`run.completed` 不生效）。修复：`appendEvent` 冲突时**重算**序列重试，`appendSystemEvent` 同样重试；二者共享 `isSequenceConflict`（限定 23505 + 具体约束名）。
4. **系统说明事件被运行时事件静默吞掉（质量评审 D4）。** 去重键为 `(attempt_id, event_type)` 时，适配器先写的 `run.failed` 会让授权撤销说明被丢弃。修复：去重额外限定系统作者前缀 `id like 'event-system-%'`。
5. **复核异常一律当作「授权已撤销」（质量评审 D2，高危）。** `sweepWorkspaceActiveRuns` 吞掉任何异常并取消该空间**全部**在途运行——一次 DB 抖动即造成 AC-26 所防的误删。修复：新增 `isAuthorizationDenial` 只对可分类的授权拒绝取消；基础设施故障记日志并放行（执行前复核与下一轮修订变更仍会兜底）。
6. **SSE 建连降级绕过（规格评审 GAP-1，高危，已实证）。** 建连用成员相关的 `resolveWorkspaceType` 判定团队分支，被移出成员重连解析为 `null` → 退化为无逐批拦截的个人路径并继续交付内容。修复：改用不依赖成员身份的 `workspaceTypeOf`，非成员 fail-closed 403（显式包装为权限错误，不依赖错误消息分类）。有专测：先移除再建连，去掉修复即失败。
7. **`executeClaimed` 终态守卫。** 复核通过后、`runtime.execute` 前再确认状态，被撤权取消的 run 不得进入 Runtime（AC-09「取消与完成」竞态）。

**测试夹具缺陷（9 处，均为夹具与产品语义不一致，非产品缺陷）：**
- 两处「成员已移除 / Agent 已停用」只在事件表插了行、没有真正改业务状态，被 `isRevocationEffective` 当前状态门（正确地）跳过；须真调 `members.removeMember` / 置 `disabled`（并移除与事件去重键冲突的手工插入）。
- 一处对照空间的 run 请求人不是该空间成员，修订号全量复核会以「非成员」正确取消它，掩盖跨空间隔离断言。
- 一处 run 先于其 session 插入，违反 `runs_tenant_id_session_id_fkey`。
- 一处重复插入个人空间：`0013` 的 `users_personal_workspace_provisioning` 触发器已在插入 users 时自动创建，夹具应复用而非再插。
- 调度容量：`claimAttempt` 按 runtime 全局统计 `status='running'` 的 attempt，多个用例直接落库 `running` 夹具会跨用例耗尽默认容量 2。测试运行时容量提升到 32。
- 两处 SSE 竞态用例在流启动前就落库了「撤权后」的事件，首轮即全量交付、竞态窗口根本不存在；改为在竞态点之后才写入事件。
- 一处复核失败断言在 run 置 `failed` 后立即读说明事件，而说明事件是随后写入的；改为等待事件落库。

**两条硬约束的落地证据：**
- 事件去重 + 当前状态门：`isRevocationEffective` 逐事件复核当前授权状态；`team_auth_revision` 变更触发全空间复核兜底。`team_auth_revision` 全仓只有 `+1` 自增（不可能回退，重启重放安全）。Agent 事件此前把操作人写进 payload/`user_id`，导致重复生命周期产生多行、违反去重语义，已改为只由被撤销对象决定。
- 个人空间零改动：`recheckExecutionAuthorization` 在 `workspaceType !== 'team'` 时早退；`streamRunEvents` 的 `teamAccess` 可选，路由只在团队分支传入；授权层 workspace capabilities 仅在 `workspaceType === 'team'` 时校验；用户 `cancel()` 逐字未改。

**已知遗留（评审记录，非 T5 阻断项，转 T7 或后续批次）：**
- ~~清扫器错误处理无 attempts 上限/死信（D7）~~ **已修**：迁移 `0023` 增加终态 `dead_letter` + `last_error`，`MAX_EVENT_ATTEMPTS=20`（约 40s）后单语句升级，有回归测试。
- `readWorkspacesNeedingSweep` 的 pending 事件不限空间状态，归档/非 active 空间的 pending 事件无归宿（D8）。
- 清扫器 `close()` 不 await 在飞清扫，关闭序列有竞态噪声（D9）。
- 三个 `listActiveRuns*` 查询缺少 `(tenant_id, status)` 起始索引，修订号变更时是 O(active runs × 查询数)（D10）。
- ~~`teamReadAccessCache` 只写不淘汰（D5）~~ **已修**：超阈值清理 TTL 过期项并硬性封顶；缓存键已加租户维度（D6 已缓解）。
- `failRunForRevokedAuthorization` 先置 `failed`、后写说明事件，二者之间事件不可见（产品可接受，测试已等待）。
- `isAuthorizationDenial` 仍按 15 条错误文案子串判定（授权服务抛普通 Error）；已加单测锁定契约（`test:m5:revocation`），后续若引入类型化错误码应替换。

## 4. T6 前端成员管理（已完成，见 §2 与 §3 评审结论）

- 依据 `team-workspace-design.md` §2.5/2.6/2.7：成员管理弹窗（员工/Agent 同屏分段、角色下拉、添加员工搜索、添加 Agent 确认流）、`WorkspaceInfoPanel` 团队分支（员工+Agent 分区、「管理成员」入口、「空间设置」入口）、`ConversationStarter` 预选 Agent（团队分支）。
- 后端 API 已就绪（T3/T4），API client 方法已同步（`client.ts`/`domain.ts`），只需做 UI + store + 前端测试（`pnpm test:m5:frontend`）。
- 空间设置弹窗中「归档」行为属批次 3，1A 只做入口或不做（按设计文档 2.7 的批次标注）。

## 5. T7 对账清单与迁移验证（已完成，见 §2 与 §3 评审结论）

- admin 运营端 legacy 授权来源对账清单（`admin/operations-routes.ts` 现有 `GET /workspaces` 基础）+ 对账完成前阻止破坏性调整。
- `agents.allow_workspace_join` 的 admin 治理开关（T4 迁移注释写明"no API yet"，此任务补）。
- 迁移集成验证：全新安装/升级/重跑/回滚（AC-17/AC-27 口径）。
- 遗留观察：0013 触发器对 personal→team 移动不校验旧空间（评审已记录，可在此任务一并修或记录决策）。

## 6. 1B 团队资料与本人对话（进行中）

**范围（方案 §7 批次 1B）**：TW-03 本人历史列表、TW-05 共享文件、团队 Session 分页、来源限制采集、文件／SSE 收权、可见统计性能基线。**依赖 1A 的授权与撤权机制（已交付）**。

**退出条件（方案 §7）**：A 上传不可变文件，B 引用完成真实 DSH 对话并能继续；AC-09 收权通过，输入与结果可追溯来源限制，个人空间回归不变。

**实现要点（设计 §2.2 / §2.3 + 方案 §6.2 / §6.3 / §6.6）**：
- 员工端对话页签「新对话／历史对话」segmented 切换，写入 `?view=history`，历史视图替换 Starter：标题搜索 + 游标分页（「加载更多」／「已加载全部」）、行含状态点/标题/发起人/最近活动/最新运行状态、整行进入 `/conversations/:runId`（服务端解析到 Session，兼容 Run ID 链接）。**「我的对话／团队共享」与发起人筛选属 2A，首版不渲染空入口。**
- 团队 Session 分页服务端接口：按 Session 去重、稳定排序（最近活动倒序）、按授权结果汇总分页与计数；新增必要索引与摘要投影（方案 §6.3「Session 查询」）。
- 共享文件页签：名称搜索、状态映射（上传中/处理中/可引用/失败+原因）、操作区「引用到对话 + 下载 + 更多（移除）」、权限（只读成员不渲染上传与移除；成员仅对自己上传的显示移除）。**「上传新版本」属 TW-07（P1），本批不渲染。**
- **来源限制采集**（方案 §6.3）：为团队输入文件、知识或工具返回数据记录可追溯来源标识与访问限制并随结果保存；缺失限制标记为「不可判定」。这是 2A 派生/撤回的前置。
- 文件与 SSE 收权按 1A 已有机制扩展：文件下载、结果读取与已建立订阅在失权后拒绝（AC-09 口径）。
- 可见统计性能基线（方案 §6.6）：多成员、多会话、单会话 >50 Run 的数据基线，记录查询计划、延迟分位数、数据量与并发。

**承接 1A 的硬约束**：
- **个人空间零改动（AC-23）** 仍是红线：团队分页/来源限制/收权只在团队分支生效，个人空间接口与页面行为保持现状。
- 新增集成套件必须用 `createThrowawayDatabase()`（见 §7），不要直连共享库。
- 新增/修改 API 必须同步 OpenAPI 契约并跑 `pnpm verify`；新增授权拒绝统一抛 `authorizationDenied(...)`（勿再依赖文案分类）。

**1A 遗留中与本批相关的项**：`GET /workspaces` 的 `owner` 仍是创建者显示名且缺 `status`（历史列表「发起人/负责人」展示口径、归档筛选依赖它）；员工名册无 `department`；Agent「不可用」第三态与原因。

## 7. 工程约定

- **测试数据库**：本机 docker 容器 `dsh-work-postgres-local`，端口 15433，`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。`DSH_WORK_TEST_DATABASE_URL` 只需指向该实例的 `postgres` 维护库；**全部 21 个集成套件**（`server/src/**/*integration.test.ts`）统一通过 `server/src/infrastructure/postgres/test-database.ts` 的 `createThrowawayDatabase()` 各自创建、迁移、销毁一次性库，因此不再有共享库历史污染问题——此前「**不要**对共享 dev 库 `dsh_work` 跑 T2 套件（历史污染导致误失败）」的警告已随该迁移失效。**新增集成套件请直接用该 helper，不要再直连共享库。**
- **验证命令**：`pnpm verify`（文档/契约静态检查，改 OpenAPI 后必跑）、`pnpm lint`（含 architecture 与 UI 校验）、`pnpm --filter @dsh-work/server typecheck`。测试脚本已并入 server/package.json 与根 package.json（`test:m4:team-auth:integration`、`test:m5:workspace:integration`、`test:m5:members:integration`、`test:m5:agent-members:integration` 等）。
- **提交规范**：conventional commits，中文或英文 message 均可，`feat(server):`/`fix(server):`/`docs:` 前缀；每任务一个 feat + 若干 fix。
- **工作流**：subagent-driven-development——实现子代理（TDD，先红后绿）→ 规格符合性评审（独立验证、重跑测试）→ 代码质量评审（对抗性验证，前序任务靠它抓到 6 个并发类缺陷）→ 修复 → 复审。评审不可跳过；本批次每个任务的修复轮都来自评审发现。
- **个人空间零改动**是贯穿所有任务的验收红线（AC-23）。

## 8. 1A 退出条件（已达成）

- 两名员工和一个 Agent 可协作 ✅：员工成员 API（T3）+ Agent 成员 API（T4）+ 名册接口 + 员工端成员管理与 Agent 发起入口（T6）。
- 多 Agent 共享授权不误删（AC-26）✅：`workspace_grant_sources` 多来源、撤销单来源不误删（`workspace-agent-member-api` 用例）、legacy 对账后保留共享工具授权（T7）。
- Agent 或员工收权能阻止新增、排队和后续交付（AC-09）✅：撤权清扫 + 执行前复核 + 系统取消 + SSE 逐批拦截 + REST 详情/列表/取消读取拦截（T5 及其评审修复）。

以上三条由 `pnpm verify` 的 `team-workspace-1a` 检查组锁定证据锚点（契约路径、迁移、关键用例），任一处被删或改名即失败。`team-workspace-plan.md` 第 10 节已同步交付状态；下一批为 1B（见 §6）。
