# Skill 创建专家与 Skill 可见范围

设计见 [Skill 创建专家方案](../../docs/design/skill-creator-plan.md)，原型见方案页首链接。规则落地前仍以[功能规则第 5 节](../../docs/development/feature-rules.md#5-skill-安装与发布)为准。标注“待建”的 spec 文件随对应实施切片创建。

## Skill 可见范围（SC4）

### SKC-VIS-01 管理员限定 Skill 可见角色后，只有这些角色的员工能在 Skill 广场选用

**优先级：** P1 · **角色：** 平台管理员、两位不同角色的员工 · **运行层级：** 专用可丢弃 PostgreSQL、受控测试身份、真实 HTTP 接口与浏览器<br>
**前置数据：** 一个已发布、可见范围为全员的 Skill；员工甲属于“销售部”，员工乙不属于；一个固定引用该 Skill、两位员工都能使用的 Agent<br>
**spec：** `server/src/infrastructure/postgres/skill-visibility.integration.test.ts`、`e2e/personal-integration/skill-visibility.spec.ts`（待建）

1. 未设置可见范围时，两位员工的 Skill 广场都能看到该 Skill（保持现有行为）。
2. 管理员在 Skill 详情把可见范围改为“销售部”，填写原因后保存；审计记录这次修改。
3. 员工甲刷新 Skill 广场仍能看到并选用；员工乙看不到，直接按该 Skill 发起对话被拒绝并提示没有使用权限。
4. 员工甲选用该 Skill 发起对话后，管理员把员工甲移出“销售部”：员工甲在该会话再次发送时，执行前复核拒绝并说明原因。
5. 员工乙使用固定引用该 Skill 的 Agent 正常运行（Agent 固定引用不受 Skill 可见范围限制）。
6. 管理员把可见范围改回全员：员工乙重新能看到该 Skill。

**验收：** Skill 广场、会话选择与执行前复核三处口径一致；Agent 固定引用不受限；存量 Skill 默认全员，不需要迁移数据。

## Skill 创建专家

### SKC-01 员工经推荐进入 Skill 创建专家，生成草稿并自己提交审核

**优先级：** P1 · **角色：** 员工 · **运行层级：** 一次性 PostgreSQL、合成 Runtime（不调用模型）、真实 HTTP 接口与浏览器<br>
**前置数据：** 已发布并开启“可创建 Skill”的 Skill 创建专家；合成 Runtime 对含 `P1-创建Skill` 的 prompt 在工作区写出一个合法 Skill 目录并调用 `skill_draft_save`<br>
**spec：** `e2e/personal-integration/skill-creator.spec.ts`、`apps/workbench-web/src/components/conversation/conversation-components.test.ts`

1. 员工在 dsh-work 助手的推荐卡片上点“去聊天”，进入 Skill 创建专家的新对话，问题已预填。（待 Skill 创建专家发布后补测；推荐机制本身由 `REC-01` 覆盖。）
2. 发送后回复下方出现草稿卡片：名称、说明、文件清单（脚本单独标注）、包校验结论、可展开的 SKILL.md 预览与“提交审核”；不声称平台验证过试跑。A 工作模式与 B 单聊一致。
3. 点“提交审核”：卡片变为“待审核”，出现“撤回提交”；刷新后状态不变。
4. 点“撤回提交”：卡片回到草稿状态，可再次提交。
5. 从 Skill 广场点“创建 Skill”，进入与 Skill 创建专家的新对话，没有预填。（待实施：入口随 Skill 创建专家发布一起加入。）
6. 已有 5 条待审核提交时再提交，提示已达上限，提交不成功。（由 `SKC-03` 的集成测试覆盖。）

**验收：** 提交只能由员工在卡片上发起；状态在刷新后保持；上限生效。P0 冒烟不覆盖本条（冒烟服务不执行对话）。

### SKC-02 管理员审核员工提交：看内容与试运行证据，通过时选择可见范围或填写原因拒绝

**优先级：** P1 · **角色：** 平台管理员、提交员工 · **运行层级：** 一次性 PostgreSQL、合成 Runtime、真实 HTTP 接口与浏览器<br>
**前置数据：** 两条待审核提交：一条含脚本且自动试运行已通过，一条纯指令且试运行未完成<br>
**spec：** `e2e/skill-submission-review.integration.spec.ts`（待建）

1. 管理员打开 Skill 管理的“待审核”，看到两条提交，显示提交人、来源“对话创建”、是否含脚本、试运行状态与提交时间。
2. 打开含脚本的提交：可分别查看 SKILL.md、脚本源码与试运行证据（激活证据、每个 Python 入口退出码 0）。
3. 点“通过并发布”，选择“指定角色”但不勾选任何角色时不能确认；勾选“销售部”后确认，提交变为已发布，Skill 出现在 Skill 列表，可见范围为销售部；提交员工收到站内通知，草稿卡片显示已发布。
4. 对试运行未完成的提交，“通过并发布”不可用并说明原因；点“拒绝”，原因为空时不能确认；填写原因后确认，提交员工的草稿卡片显示拒绝原因。
5. 非管理员访问审核接口返回无权限。

**验收：** 未通过严格试运行不能发布；拒绝必须有原因；发布复用现有发布确认与审计。

### SKC-03 草稿工具的装配范围、校验与归属

**优先级：** P1 · **角色：** 员工、平台管理员 · **运行层级：** 专用可丢弃 PostgreSQL、受控测试身份<br>
**前置数据：** 开启与未开启“可创建 Skill”的 Agent 各一；一个团队空间<br>
**spec：** `server/src/modules/runtime/builtin-tools.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/modules/skill/skill-submission-workspace.test.ts`、`server/src/infrastructure/postgres/skill-submission.integration.test.ts`

1. 开启开关的 Agent 在个人空间员工对话中装配 `list_available_skills` 与 `skill_draft_save`；未开启、团队空间、定时与主动任务、发布试运行、系统与管理运行不装配；Skill 声明这两个工具时安装校验报不兼容。
2. `list_available_skills` 只返回发起员工可选用的已发布 Skill 与平台内置 Skill。
3. `skill_draft_save` 按现有包规则校验：缺少 frontmatter、不支持的文件类型、超出文件数或大小、声明未安装的 Python 依赖时返回不兼容原因，草稿不能提交；与已有 Skill 或平台内置 Skill 重名时拒绝。
4. 每次保存生成新的不可变版本；提交记录归属发起员工，来源为“对话创建”，记录发起员工与执行的 Agent。
5. 其他员工不能提交、撤回或查看该草稿；被拒绝后在原会话再次保存生成新版本，可重新提交。

**验收：** 装配范围与校验和现有 Skill 安装一致，不开宽松通道；归属与来源可追溯到 Run/Attempt。

### SKC-P2 真实 DSH 下从需求到发布

**优先级：** P2 · **角色：** 员工、平台管理员 · **运行层级：** 真实 DSH Run/Attempt、Runtime Adapter、执行容器<br>
**前置数据：** 已发布的 Skill 创建专家；Skill 广场中至少一个已发布 Skill<br>
**spec：** 手工执行并留证

1. 纯指令需求（如固定格式的会议纪要）：专家先查重、问清需求，生成不含脚本的草稿，员工提交后管理员通过并发布，员工在 Skill 广场选用后运行正常。
2. 需要脚本的需求（如合并多个 Excel 计算汇总）：专家在执行容器中试跑脚本通过后才保存草稿；自动严格试运行通过后发布。
3. 需求与已有 Skill 相符：专家引导去用现有 Skill，不新建。
4. 员工要求写入越权或外传数据的指令：专家拒绝写入并说明原因。

**验收：** 留存 Run/Attempt、草稿版本与审核记录；记录专家是否先查重、是否过度使用脚本的人工结论。P1 绿灯不能替代本层。
