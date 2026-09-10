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
| **1A-T5 收权链路** | ⚠️ **进行中**：WIP 提交 `f45686b`（+1808 行，typecheck 通过，**集成测试未跑**，未经任何评审） | — |
| 1A-T6 前端成员管理 | 待开始 | — |
| 1A-T7 对账清单与迁移验证 | 待开始 | — |

## 3. T5 接手步骤（最优先）

`f45686b` 是被打断的实现代理留下的 WIP，含：`run-revocation-sweep.ts`（新）、`systemCancelRun`、`cancelCause='system_revoke'`（runtime adapter + types）、execute 前复核、SSE 团队分支逐批写出检查、新测试文件 `m5-revocation-pipeline.integration.test.ts`（1808 行中含大量测试，但**未在 WIP 状态运行过**）。

接手顺序：

1. **先读规格**：`team-workspace-batch-1a-convergence.md` §4（七条机制 + 已确认决策）与 `team-workspace-plan.md` §5 执行原则 5/6、AC-09。
2. **跑 WIP 测试**：`pnpm test:m5:revocation:integration`（若脚本已加）或直接跑新测试文件；先修到绿再评审（此时不要信任未验证的代码）。
3. **规格评审**：对照 T5 规格逐项核对（系统取消幂等收敛、清扫范围——成员移除/角色降级/Agent 停用各自取消哪些 run、SSE 拦截、execute 复核、个人路径零改动）。
4. **质量评审**，修复后复审，流程同前序任务。

**T5 两条硬约束（前序评审遗留，规格里必须体现）：**
- 事件表按 `(workspace_id, user_id, kind, payload_hash)` 去重——重复生命周期事件（降级→升回→再降级、停用→启用→停用）只产生一条事件。**消费者必须基于当前授权状态 + `team_auth_revision` 重新判定**，事件只是触发清扫的提示，不是事实来源。必须有测试覆盖"第二次停用仍会取消期间新起的运行"。
- 个人空间/standalone 路径零改动（AC-23）：SSE 拦截、execute 复核只在团队分支生效。

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
