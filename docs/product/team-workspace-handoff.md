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
| **1A-T5 收权链路** | ✅ **实现完成、两级评审已修**：`f45686b` + `8a95574`/`94d1ddd` + 评审修复；`pnpm test:m5:revocation:integration` **18/18 且连续 10 次稳定**，typecheck/verify/lint 通过 | `f45686b`、`8a95574`、`94d1ddd` |
| 1A-T6 前端成员管理 | 待开始 | — |
| 1A-T7 对账清单与迁移验证 | 待开始 | — |

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

## 4. T6 前端成员管理（待开始，规格要点）

- 依据 `team-workspace-design.md` §2.5/2.6/2.7：成员管理弹窗（员工/Agent 同屏分段、角色下拉、添加员工搜索、添加 Agent 确认流）、`WorkspaceInfoPanel` 团队分支（员工+Agent 分区、「管理成员」入口、「空间设置」入口）、`ConversationStarter` 预选 Agent（团队分支）。
- 后端 API 已就绪（T3/T4），API client 方法已同步（`client.ts`/`domain.ts`），只需做 UI + store + 前端测试（`pnpm test:m5:frontend`）。
- 空间设置弹窗中「归档」行为属批次 3，1A 只做入口或不做（按设计文档 2.7 的批次标注）。

## 5. T7 对账清单与迁移验证（待开始，规格要点）

- admin 运营端 legacy 授权来源对账清单（`admin/operations-routes.ts` 现有 `GET /workspaces` 基础）+ 对账完成前阻止破坏性调整。
- `agents.allow_workspace_join` 的 admin 治理开关（T4 迁移注释写明"no API yet"，此任务补）。
- 迁移集成验证：全新安装/升级/重跑/回滚（AC-17/AC-27 口径）。
- 遗留观察：0013 触发器对 personal→team 移动不校验旧空间（评审已记录，可在此任务一并修或记录决策）。

## 6. 工程约定

- **测试数据库**：本机 docker 容器 `dsh-work-postgres-local`，端口 15433，`postgres://dsh_work:change-me@127.0.0.1:15433/postgres`。集成测试套件各自创建/销毁一次性库（`DSH_WORK_TEST_DATABASE_URL` 指向 postgres 库即可）。**不要**对共享 dev 库 `dsh_work` 跑 T2 套件（历史污染导致误失败）。
- **验证命令**：`pnpm verify`（文档/契约静态检查，改 OpenAPI 后必跑）、`pnpm lint`（含 architecture 与 UI 校验）、`pnpm --filter @dsh-work/server typecheck`。测试脚本已并入 server/package.json 与根 package.json（`test:m4:team-auth:integration`、`test:m5:workspace:integration`、`test:m5:members:integration`、`test:m5:agent-members:integration` 等）。
- **提交规范**：conventional commits，中文或英文 message 均可，`feat(server):`/`fix(server):`/`docs:` 前缀；每任务一个 feat + 若干 fix。
- **工作流**：subagent-driven-development——实现子代理（TDD，先红后绿）→ 规格符合性评审（独立验证、重跑测试）→ 代码质量评审（对抗性验证，前序任务靠它抓到 6 个并发类缺陷）→ 修复 → 复审。评审不可跳过；本批次每个任务的修复轮都来自评审发现。
- **个人空间零改动**是贯穿所有任务的验收红线（AC-23）。

## 7. 1A 退出条件（完成 T5/T6/T7 后核对）

- 两名员工和一个 Agent 可协作；
- 多 Agent 共享授权不误删（AC-26）；
- Agent 或员工收权能阻止新增、排队和后续交付（AC-09 口径，T5 交付）。

完成后按批次退出条件更新 `team-workspace-plan.md` 第 10 节交付状态，再进入 1B 规划。
