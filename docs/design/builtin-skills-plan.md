# 平台内置 Skill 方案

**状态：** 待评审，尚未实施。本文所述能力在实施并通过第 9 节验收前均不可用；当前平台没有内置 Skill，所有 Skill 都由管理员安装发布，经 Agent 版本固定或员工在 Skill 广场选择后才进入运行。<br>
**更新日期：** 2026-10-29<br>
**依据：** 当前 Skill 安装与运行代码（`skill-package.ts`、`postgres-skill-service.ts`）、Agent 运行快照（`postgres-agent-service.ts` 的 `getRuntimeSnapshot`）、员工侧派发（`attempt-dispatcher.ts`）、Manifest 编译（`manifest-compiler.ts`）、Runtime Adapter 的 Skill 目录注入（`dsh-acp-runtime-adapter.ts`）与执行容器工具链（`execution-toolchain.ts`）。

## 1. 背景与目标

平台已为每个员工侧 Agent 运行装配文件工具与执行容器中的 `bash`（[Agent 设计规范 6.3](../development/agent-design-standard.md#63-平台默认能力与-llm-自主调用)），分析文件、生成 HTML 和 Office 成果在“工具层面”都可以完成。但“具备工具”不等于“做得好”：没有方法指引时，产出质量取决于模型临场发挥，常见问题包括没通读就下结论、不标出处、心算数据、HTML 依赖外链导致离线预览失效、先用 `write` 写 `.html` 被拒后再改用 `bash` 多走一轮。

目标：

- 用户不配置任何 Skill，员工侧 Agent 在文件分析、HTML 页面、Office 文档三类日常场景中就有稳定的基线质量；
- 管理员或员工选用了覆盖同一场景的更强 Skill 时，确定性地以该 Skill 为准，内置 Skill 不再出现在本次运行的目录中；
- 复用现有 Skill 版本、渐进式目录、`activate_skill`、Manifest 固定和激活记录，不新增第二套 Skill 机制或执行逻辑。

非目标：

- 不新增工具、权限、数据范围或预算；内置 Skill 只提供方法，能做什么仍由内置工具注册表和执行策略决定；
- 不改变 Agent 版本固定 Skill、Skill 广场选择 Skill 的现有规则；
- 不让内置 Skill 进入系统与管理运行（会话摘要、项目档案员、管理助手、Skill 安装与试运行）。

## 2. 已拍板决策（2026-10-29）

| 编号 | 决策 | 结论 |
| --- | --- | --- |
| BS1 | 内置 Skill 更新后，Agent 已有验证结果是否作废 | **不作废，随代码发布生效**，与内置工具注册表一致；每个 Attempt 记录实际使用的 `id@version`，可追溯；每次发布前跑内置 Skill 评测（第 7 节） |
| BS2 | 用户 Skill 怎样覆盖内置 Skill | **按声明确定性覆盖**：管理员在 Skill 上标记“覆盖内置场景”，运行中有该 Skill 时去掉对应内置 Skill；未标记时两者并存，由目录说明引导模型优先使用专门 Skill |
| BS3 | 首批范围 | **文件分析、HTML 页面、Office 文档**三个 |

## 3. 边界

- **执行职责不变。** 内置 Skill 与其他 Skill 一样，由 DSH 在单次 Attempt 内按需激活并遵循；平台只负责装配和固定版本，不在平台侧调用模型或新增执行循环（[AGENTS.md](../../AGENTS.md)、[总览 3.5](../development/overview.md#35-agent-执行引擎统一)）。
- **指令优先级不变。** Soul、AGENTS 工作规程和平台规则优先于任何 Skill；内置 Skill 是最低优先级的通用方法，与 Agent 职责冲突时以 Agent 指令为准。
- **不能声明 `bash`。** 注册表中 `bash` 的装配方式为 `execution-container`，Skill 声明会被 `invalidSkillToolReferences` 拒绝。HTML 与 Office 两个内置 Skill 的 `allowed-tools` 只声明读工具，正文引导模型在 `bash` 可用时用它生成文件，`bash` 被 Runtime 紧急停用时改为输出 Markdown 并说明原因。
- **不进入 Skill 广场。** 内置 Skill 默认始终生效，员工端 Skill 广场只列管理员安装的已发布 Skill（[功能规则 5.2](../development/feature-rules.md#52-包规则)：只显示曾作为安装根节点的 Skill）。
- **不改变工具策略。** 放宽 `write` 允许 `.html` 是可选的后续改进，不是本方案前提（第 10 节）。

## 4. 现状依据

| 事实 | 位置 | 对方案的影响 |
| --- | --- | --- |
| Skill 以渐进式目录进入系统提示，每个只占一行，调用 `activate_skill` 才加载正文 | `dsh-acp-runtime-adapter.ts` 中“可用 Skill 目录”段落 | 为所有员工侧运行增加三个内置 Skill，平时只多三行目录 |
| `activate_skill` 仅在本次有 Skill 时装配 | `attempt-dispatcher.ts` 的 `toolNames` | 内置 Skill 生效后，员工侧运行基本都会装配 `activate_skill` |
| Agent 固定 Skill 与会话选择 Skill 在 `mergeSkillReferences` 合并，再校验已发布并解析为运行快照 | `postgres-agent-service.ts` 的 `getRuntimeSnapshot` | 内置 Skill 在同一处合并，复用发布校验、工具闭包检查和正文解析 |
| Manifest 编译时目录名称（`name ?? id`）重复直接抛错 | `manifest-compiler.ts` | 内置 Skill 必须使用保留名称，安装时拒绝同名，否则相关 Agent 的所有运行都会失败 |
| 严格激活证据只在 `admin-skill-test` 中要求；Agent 发布验证不检查每个 Skill 是否激活 | `admin-skill-installation-service.ts`、功能规则 5.3、第 9 节 | 内置 Skill 没被用到不会让 Agent 验证失败 |
| `skills.owner_user_id` 非空且外键到 `users`；表中没有来源字段 | 迁移 `0001_m2_platform.sql` | 需要迁移增加来源，并允许内置 Skill 不挂具体用户 |
| SKILL.md frontmatter 中未识别的键被忽略 | `skill-package.ts` 的 `parseEntry` | 覆盖声明不放进第三方包，改为平台侧配置（5.4） |
| 执行容器探测 pandoc、LibreOffice、python3 及 pandas、openpyxl、python-docx、python-pptx，均为可选，结果写入 Runtime 说明 | `execution-toolchain.ts` | Office 与 HTML 基线可行，但 Skill 正文须先看 Runtime 说明再选工具，缺失时降级 |

## 5. 方案

### 5.1 交付与同步

- 内置 Skill 放在仓库 `server/builtin-skills/<key>/` 下，每个目录是一个符合[功能规则 5.2](../development/feature-rules.md#52-包规则)的 Skill 包（`SKILL.md` 及可选参考文件），随代码发布。代码中另有一份内置 Skill 注册表，声明 `key`、覆盖场景和目录名称；注册表是唯一来源，与内置工具注册表同一治理方式。
- 服务启动时按租户同步：用现有包解析与校验逻辑读取每个目录，写入现有内容寻址存储（`skills/packages/<name>/<sha256>/`），在 `skills` / `skill_versions` 中创建或复用对应记录，状态直接为 `published`。版本号取 frontmatter 的 `version`；同一版本号对应的内容摘要变化时启动失败（防止原地改写已发布内容），内容变化必须升版本号。旧版本保留，供历史 Attempt 追溯。
- 同步失败（包不合法、版本冲突、存储不可写）属于发布缺陷，服务启动检查失败并说明原因，不静默跳过；CI 中对每个内置 Skill 跑包解析测试，提前发现问题。
- 迁移：`skills` 增加 `source`（`installed` | `builtin`，既有数据为 `installed`）；`source = 'builtin'` 时 `owner_user_id` 可为空。内置 Skill 的 `key` 使用保留前缀 `dsh-work-`，目录名称使用保留名称（如“文件分析（平台内置）”）；三个安装入口在解析阶段拒绝保留前缀与保留名称。
- 内置 Skill 在管理端只读：不能编辑、上传新版本、发布、回滚或删除；唯一的运维动作是 Runtime 紧急停用（5.3）。

### 5.2 包内容约定

- frontmatter 必须有 `name`、`description`、`version`；`description` 写明“平台内置的通用方法；目录中有更专门的 Skill 时优先使用后者”。
- `allowed-tools` 只声明 `read`、`glob`、`grep`，不声明 `python_execute`（首批不带脚本）和 `bash`；工具闭包检查因此对所有 Agent 都能通过，不受联网搜索开关影响。
- 正文以“何时使用 → 步骤 → 输出要求 → 完成前自检 → 不可用时的降级”组织，控制在数千字以内；不写平台路径细节（路径由 Runtime 说明给出）。

### 5.3 运行装配

- **装配位置：** 只在员工侧派发（`AttemptDispatcher.dispatch`，覆盖对话、定时任务和 `agent-release-trial`）合并内置 Skill；系统与管理运行另行编译 Manifest，不装配。发布试运行也装配，保持“验证与生产一致”（[功能规则第 9 节](../development/feature-rules.md#9-agent-验证与发布)）。
- **解析顺序：** 本次内置 Skill 集合 = 注册表中的内置 Skill − Runtime 紧急停用的 − 被本次 Skill 覆盖的（5.4）。结果在 Agent 固定 Skill 与会话选择 Skill 之后合并，目录中排在最后。
- **固定与追溯：** 内置 Skill 与其他 Skill 一样写入 Manifest 的 `skills` 与 `agent_configuration.skill_instructions`（`id@version`），激活时照常写入 `skill_runtime_activations`。被覆盖而去掉的内置 Skill 记录在 Manifest 新增的可选字段中（内置 Skill 引用与覆盖它的 Skill 引用），使“为什么这次没有内置 Skill”可查；该字段同步 `runtime-manifest.schema.json`、编译器与 Adapter。
- **授权与复核：** 内置 Skill 与内置工具一样由平台提供，不需要 Skill 授权，也不需要项目空间的能力授权（[功能规则 3.3](../development/feature-rules.md#33-agent-成员)：空间授权只包含 Agent 与 Skill，指管理员安装的 Skill），不进入、也不改变 Agent 依赖闭包与空间授权快照。现有代码中，派发时的 `authorizeRuntime` 和执行前复核（`current-execution-authorization.ts`、`postgres-authorization-service.ts` 中由 Manifest 重建 `additionalSkillReferences` 的路径）会把 `manifest.skills` 全部当作附加 Skill，经 `assertAgentDependencyClosure` 和团队空间 `requireWorkspaceCapabilities` 校验；内置 Skill 若原样进入这条路径，团队空间运行会因“工作空间未授权 Skill”被拒绝。实施时这两处先按来源分离：非内置 Skill 照常走依赖闭包与空间授权；内置 Skill 只核对仍是当前代码注册的内置版本、来源为 `builtin` 且未被紧急停用，不满足时按紧急停用语义处理，不使整次复核失败。复核其余项（身份、成员、文件、数据范围）不变，不因内置 Skill 放宽。
- **版本解析时机：** 与内置工具相同，在创建 Attempt 时解析当时代码中的版本；同一 Attempt 固定不变。代码发布后的新 Attempt 使用新版本，Agent 已发布版本和会话锁定的 Skill 版本不受影响（BS1）。
- **紧急停用：** Runtime 配置在现有“紧急停用 DSH 工具”旁增加“紧急停用内置 Skill”：新 Attempt 不再装配；执行中的 Attempt 再激活该 Skill 时只拒绝这一次并告知模型，运行本身不中断（与工具紧急停用语义一致）。

### 5.4 覆盖规则

- 内置 Skill 注册表为每个内置 Skill 声明一个固定场景：`file-analysis`、`html-page`、`office-document`。
- 管理员在已安装 Skill 的详情中设置“覆盖内置场景”（可多选上述场景，默认空）。这是 Skill 级平台配置，不写入第三方包，不随版本固定，修改立即对新 Attempt 生效并写审计；内置 Skill 自身不能设置。
- 本次运行中，只要有一个可由模型调用的非内置 Skill（Agent 固定或会话选择，`disable-model-invocation` 为否）标记覆盖某场景，就去掉该场景的内置 Skill。依赖 Skill 只随根 Skill 加载，不单独触发覆盖。
- 未标记覆盖的 Skill 与内置 Skill 并存，靠目录顺序和内置 Skill 的描述引导模型优先使用专门 Skill；这是兜底，不保证确定性。

### 5.5 首批内置 Skill

| key | 场景 | 方法要点 | 完成前自检与降级 |
| --- | --- | --- | --- |
| `dsh-work-file-analysis` | `file-analysis` | 先看文件清单与结构再通读相关部分；结论标注出处（文件名与页、表、行等位置）；区分原文事实与推断；多文件对比用表格；数值统计在 `bash` 可用时用 python/pandas 计算，不心算；说明每轮 5 个文件、解析文本合计 1 MB 的输入限制可能造成的遗漏 | 抽查结论能回到原文；有未读到或被截断的内容时明确说明；`bash` 不可用时只做文本分析并说明数值未经计算核对 |
| `dsh-work-html-page` | `html-page` | 单个 `.html` 文件，CSS/JS 内联，不引用外部字体、脚本、图片链接（执行容器断网，预览在隔离沙箱中）；语义化结构、响应式、可打印；图表用内联 SVG；用 `bash` 写入 `output/`，不要用 `write`（只接受 Markdown、TXT、CSV） | 生成后用 `bash` 检查文件存在、大小在成果上限内、无外部 URL 引用；`bash` 不可用时输出 Markdown 并说明无法生成 HTML |
| `dsh-work-office-document` | `office-document` | 先看 Runtime 说明中实际可用的工具链；Word/Excel/PPT 优先用 python-docx、openpyxl、python-pptx 生成，格式转换用 pandoc 或 LibreOffice；Excel 写值或安全公式，不写宏、外部链接或 DDE；中文字体与版式保持简单 | 生成后用对应库重新打开校验；工具链缺失时改为另一种可用格式或 Markdown 并说明；遵守成果登记的类型、大小和安全规则（[功能规则第 1 节](../development/feature-rules.md#1-跨功能约束)） |

### 5.6 界面

- **管理端 Skill 列表与详情：** 内置 Skill 带“平台内置”标签，详情只读展示说明、当前版本、场景、正文与文件清单，不显示编辑、发布、回滚、删除。已安装 Skill 详情增加“覆盖内置场景”设置。
- **管理端 Runtimes：** 只读列出内置 Skill 及版本，提供紧急停用 / 恢复。
- **Agent 草稿编辑与员工端：** 不增加展示或开关（与 6.3“不展示基础能力”一致）；运行详情中已有的 Skill 激活记录自然包含内置 Skill。

改动集中在现有页面的标签、只读详情和一个设置项，规模小；仍按 Spec → Code → Verify → Test 执行，是否先出可点击原型在实施评审时确认。

## 6. 验证证据与变更影响

- 内置 Skill 新版本随代码发布生效，不作废 Agent 验证结果，不要求 Agent 重新发布（BS1）。这与内置工具注册表的处理一致；[Agent 设计规范 6.7](../development/agent-design-standard.md#67-实施工作与验收) 中“修改默认能力依据使原验证失效”指 Agent 草稿上的配置变化，不包括随代码发布的注册表与内置 Skill。
- 每个 Attempt 的 Manifest 记录实际装配和被覆盖的内置 Skill 版本，历史可追溯。
- 发布说明列出内置 Skill 的版本变化与评测结论（第 7 节）。
- 管理员修改“覆盖内置场景”属于 Skill 级配置，立即生效并写审计，不作废 Skill 或 Agent 的验证证据。

## 7. 效果评估

- 每个内置 Skill 配一组固定案例（含正常任务、输入超限、工具链缺失或 `bash` 停用的降级），通过现有 `admin-skill-test` 严格试运行留下激活证据，断言使用场景试运行支持的 `reply_contains` 等现有能力。
- 质量对比：同一组案例分别在“装配内置 Skill”和“不装配”下运行，按人工 rubric（出处标注、数值正确、HTML 离线可用、Office 文件可打开）比较；首次上线须体现改进，之后每次修改内置 Skill 都重跑并写入发布说明。
- 这些评测是质量证据，不是 P2 真实验收；P0/P1/P2 分层按[项目工作规范](../../AGENTS.md)执行。

## 8. 实施切片

| 切片 | 内容 | 主要落点 |
| --- | --- | --- |
| BS-0 验收旅程 | 实现前在验收目录登记第 9 节的关键旅程（管理端只读展示与覆盖设置、员工侧装配与覆盖、团队空间运行、紧急停用） | `e2e/catalog/`、`e2e/TEST-CATALOG.md` |
| BS-A 存储与同步 | 迁移（`source`、内置 Skill 无所有者）；内置 Skill 注册表；启动同步与版本冲突检查；保留前缀与名称在三个安装入口拒绝 | `server/migrations`、`modules/skill`、启动检查、`docs/design/data-model.md` |
| BS-B 运行装配与覆盖 | 员工侧合并内置 Skill；覆盖解析；紧急停用；派发授权与执行前复核按来源分离内置 Skill；Manifest 新字段及 Schema、编译器、Adapter；激活拒绝语义 | `postgres-agent-service.ts`、`attempt-dispatcher.ts`、`postgres-authorization-service.ts`、`current-execution-authorization.ts`、`manifest-compiler.ts`、`dsh-acp-runtime-adapter.ts`、`runtime-manifest.schema.json` |
| BS-C 管理端 | Skill 列表标签与只读详情；“覆盖内置场景”设置与审计；Runtimes 列表与紧急停用；管理端 OpenAPI 与 DTO | `apps/admin-web`、`openapi-admin.json` |
| BS-D 内容与评测 | 三个内置 Skill 正文；固定案例与对比评测 | `server/builtin-skills/` |
| BS-E 规范同步 | 规范、功能规则、总览第 10 节改为已实现状态 | `docs/development/` |

BS-0 先于全部实现；BS-A → BS-B 有依赖；BS-C 依赖 BS-A 的数据结构；BS-D 可与 BS-A 并行起草，评测需 BS-B 完成后进行。

## 9. 验收

| 场景 | 可观察结果 |
| --- | --- |
| 未配置任何 Skill 的 Agent 处理附件并要求生成 HTML 报告 | Manifest 含三个内置 Skill；模型激活 HTML 内置 Skill；成果为单个离线可用的 HTML |
| Agent 固定了标记覆盖 `html-page` 的 Skill | 本次目录中没有 HTML 内置 Skill，Manifest 记录被覆盖及覆盖者；其他两个内置 Skill 仍在 |
| 员工在 Skill 广场选择标记覆盖的 Skill | 同上，仅对该会话生效 |
| 未标记覆盖的同类 Skill | 两者都在目录中，专门 Skill 排在前面 |
| 管理运行（管理助手、Skill 安装与试运行）、会话摘要、项目档案员 | 不出现内置 Skill |
| 团队空间中未授权任何额外 Skill 的 Agent 运行，含排队后的执行前复核 | 内置 Skill 照常装配，复核不因内置 Skill 报“工作空间未授权 Skill”；非内置 Skill 的空间授权照常校验 |
| Agent 发布验证 | 装配内置 Skill；未激活内置 Skill 不影响判定 |
| 紧急停用某内置 Skill | 新 Attempt 不再装配；执行中再激活被拒绝一次，运行继续 |
| `bash` 被紧急停用后要求生成 HTML 或 Word | 输出 Markdown 并说明原因，不报运行失败 |
| 上传或链接安装使用保留前缀或保留名称的 Skill | 安装计划被拒绝并说明原因 |
| 修改内置 Skill 内容但未升版本号 | 服务启动检查失败；CI 包测试先失败 |
| 代码发布内置 Skill 新版本 | 已发布 Agent 无需重新验证；新 Attempt 使用新版本，历史 Attempt 保留原版本 |
| 管理端查看内置 Skill | 只读，无编辑、发布、回滚、删除入口 |

P0 覆盖管理端只读展示与覆盖设置；P1 覆盖装配、覆盖、停用与保留名称拒绝；P2 在真实 DSH 下验证模型实际激活内置 Skill 并产出合格成果。

## 10. 风险与后续

- **过度激活：** 模型可能对简单问题也激活内置 Skill，增加一次工具调用和上下文。描述中写清适用条件；评测中观察激活率。
- **与 Agent 职责冲突：** 内置方法与某 Agent 的工作规程不一致时以 Agent 指令为准；确需完全替换时，为该 Agent 固定一个标记覆盖的 Skill。
- **工具链差异：** 执行镜像的可选工具缺失时 Office 质量下降，Skill 正文已要求先看 Runtime 说明并降级；镜像基线由执行隔离方案维护。
- **可选改进：** 放宽 `write` 允许 `.html`（同时修改注册表与 DSH 工具策略），可减少 HTML 生成多走的一步；单独评审。
- **后续候选：** 数据图表、邮件/公文写作等场景在首批评测证明有效后再按同一机制增加，每个新增都要有场景、评测和覆盖规则。
