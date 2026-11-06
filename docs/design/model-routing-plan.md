# 平台模型路由生效方案

**状态：** 已评审（2026-11-06），尚未实施。本文所述能力在实施并通过第 8 节验收前均不可用。<br>
**更新日期：** 2026-11-06（评审修订：不做 DSH 持有凭据的阶段，路由生效与模型网关同批实施；路由用途收敛为 `default` 与 `fallback`；快照区分 DSH 与网关字段；模型错误细分；补三条 ACP 启动路径、治理补强与分期）；2026-10-26（第 7 节与执行隔离方案对齐；明确 4.2 旧 Manifest 兼容与 4.7 不回退的关系）<br>
**依据：** 当前 Model 模块、Run 编排与 Runtime Adapter 代码；DSH `0.1.2-rc.1`（`76fda72979`）的 `dsh-acp`、`dsh-llm-pi-ai`、`dsh-settings-file`、`dsh-credentials-local` 源码与 README；2026-10-25 本地探针（第 3 节）；[发往模型的数据防护方案](model-data-protection-plan.md)。<br>
**执行基线：** 每个 Attempt 一个独立 DSH ACP Worker（`--profile acp --patch`），不改变进程模型。

## 1. 背景与目标

[架构总览 4.4](../development/overview.md#44-平台能力层) 记录了现状：Model 模块保存 Provider、模型和路由，但**路由只记录、不生效**。DSH ACP 固定使用 Profile 中的 `deepseek-official/deepseek-v4-pro`，凭据由 DSH 在 `DSH_HOME` 中管理；平台路由只写入 Attempt 快照（`run_attempts.model_route_snapshot`），不决定实际调用的模型。

目标：Attempt 实际调用的模型由平台路由决定，经平台模型网关转发，并留下可核对的证据。

- 管理员在管理端配置 Provider、模型和 `default` 路由后，新 Attempt 使用该路由；
- 路由随 Attempt 固定并进入 Manifest 摘要，重试和恢复沿用同一快照；
- DSH 只持有网关地址与本 Attempt 的短期令牌，不持有厂商密钥；
- 实际调用的 provider/model 与用量以网关记录为准，DSH 会话日志用于核对；
- 路由不可用时 Attempt 明确失败，不回退到 Profile 默认模型。

### 1.1 评审决策（2026-11-06）

| 编号 | 决策 |
| --- | --- |
| R1 | **不做 DSH 持有凭据的阶段。** 原 4.5 的 `dsh-managed` 凭据引用检查不实施；路由生效（MR-S2）与[数据防护方案](model-data-protection-plan.md) DLP-S1 的模型网关同批交付 |
| R2 | **路由用途只保留 `default` 与 `fallback`**，删除 `chat`、`analysis`。`fallback` 是显式重试时可手动选择的路由，不在 Attempt 内自动切换；按 Agent、项目空间或部门选择路由的规则以后另行设计 |
| R3 | **P2 真实验收**在现有 DeepSeek 官方与另一家外部厂商之间切换 `default` 路由；具体厂商与凭据在 P2 前确定 |

## 2. 边界

- **执行职责不变。** 模型调用仍在 DSH 内由 Agent Loop 发起；平台只决定本 Attempt 的模型配置。不在平台侧直接调用模型，不新增执行循环（[AGENTS.md](../../AGENTS.md)、[总览 3.5](../development/overview.md#35-agent-执行引擎统一)）。网关只做认证、转发、计量与数据防护。
- **凭据只在平台。** 厂商密钥由平台加密保存，只在网关转发时解析；DSH、Manifest、patch 中只有网关地址与 Attempt 令牌的环境变量名（R1）。
- **不做 Attempt 内自动切换。** `fallback` 路由不在 Attempt 内部生效；路由失败即 Attempt 失败，是否换路由重新执行由平台的显式重试决定（R2）。
- **`model_requirements` 保持拒绝。** Adapter 继续对声明了模型能力要求的运行返回 `MODEL_CAPABILITY_UNAVAILABLE`；目录标注的能力不能证明真实支持，另行设计。
- **不升级 DSH。** 方案基于锁定的 `0.1.2-rc.1`；2026-10-25 核对 `0.2.1-rc.3`，ACP 对外协议未变化，升级不是本方案前提。

## 3. 探针结论（2026-10-25）

在本地 DSH `0.1.2-rc.1` 源码检出上，以 `--profile acp --patch <探针 patch>` 启动，独立临时 `DSH_HOME`，上游为记录请求的 OpenAI 兼容假服务。patch 声明 `llm-pi-ai` 路由 `dshw-probe`（`api: openai-completions`、`apiKeyEnv: DSHW_PROBE_KEY`、模型 `probe-chat`），设定 `acp.provider/model`，并把 `settings.path` 指向独立文件。探针脚本保存在会话 scratchpad，未进入仓库。

| 用例 | `session/new` | 首轮调用 | 上游实际收到 |
| --- | --- | --- | --- |
| 正常 | 成功，`configOptions` 中 `model.currentValue = ["dshw-probe","probe-chat"]` | 成功 | `model: probe-chat`，携带 Bearer 凭据 |
| 模型未声明 | 失败：`pi-ai provider "dshw-probe" has no configured model "not-declared"` | — | 无请求 |
| 缺凭据（环境与凭据文件均无） | **成功** | 失败：`no credential for provider route "dshw-probe"` | 无请求 |
| `settings.path` 指向含同名路由的 `settings.yaml` | 成功 | 失败：连接错误，请求被改写到 settings 中的地址 | 无请求 |
| 同上，但 `settings.path` 指向平台独立文件 | 成功 | 成功 | patch 声明的路由生效 |

据此得出的事实：

1. **初始模型由 patch 决定。** `acp` 插件配置的 provider/model 即 Agent 的初始选择；`session/new` 会解析该选择，模型未声明时立即失败。ACP 的 `initialize` 也按该配置判断图片输入支持（`packages/acp/acp/src/index.ts`），因此**不使用** `session/set_config_option` 切换模型：会话建立后再切换，`session/new` 仍依赖 Profile 默认模型可用，图片能力判断也会停留在默认模型上。
2. **`session/new` 不校验凭据。** 凭据在首次模型请求时才解析，缺失时以 `MISSING_CREDENTIAL` 类错误让首轮失败。仅凭 `currentValue` 不能证明路由可用。
3. **共享 `settings.yaml` 会覆盖 patch。** `dsh-settings-file` 的路由段落热加载并覆盖适配器配置；`settings.path` 可配置，每个 Attempt 指向平台独立文件即可隔离。
4. **会话日志能区分“请求的模型”和“实际返回的模型”。** `request/header.data.header.config` 与 `request/context.data` 记录选择，调用失败时也会写入；`assistant/message.data.message.source` 只在模型实际返回时出现。
5. **候选目录包含未配置凭据的内置模型。** `configOptions` 仍列出 `deepseek-official` 的内置目录模型；平台不开放会话内切换，不受影响。
6. **未验证：** `reasoning_effort`（假上游未声明推理档位）、真实厂商的流式与工具调用兼容性、Anthropic 协议路由；`dsh-llm-deepseek` 能否改指向自定义地址（由数据防护方案 DLP-S0 验证，见 4.3）。

## 4. 方案

### 4.1 执行链路

```text
Admin 配置 Provider / 模型 / 路由（含 trust_level）
        │
Attempt Dispatcher ── resolveRoute('default' 或显式重试指定的 'fallback') ──> ModelRouteSnapshot（不含密钥）
        │  写入 Manifest.model_route（进入 SHA-256）与 run_attempts.model_route_snapshot
        ▼
Runtime Adapter
  1. 签发 Attempt 短期令牌（绑定租户、Run、Attempt、路由与模型）
  2. 生成每 Attempt patch：settings.path 隔离 + 模型路由（baseURL=网关，apiKeyEnv=令牌变量）+ acp.provider/model
     （与 MCP patch 合并为一个文件）
  3. spawn DSH ──> initialize ──> session/new
  4. 校验 configOptions.model.currentValue == [provider, model]，不符即失败
  5. 执行：DSH ──> 模型网关（校验令牌、数据防护、用平台密钥转发、计量）──> 厂商
  6. 终态：实际 provider/model 与用量取网关记录，与会话日志 source 核对
```

### 4.2 Manifest 携带路由快照

Dispatcher 当前只把 `model_route_id` 写入 Manifest（[attempt-dispatcher.ts](../../server/src/modules/run/orchestration/attempt-dispatcher.ts)）。改为写入不含密钥的 `model_route`，字段按使用方分开：

| 字段 | 来源 | 使用方 | 用途 |
| --- | --- | --- | --- |
| `route_id`、`route_key`、`purpose` | `model_routes` | 审计 | 追溯 |
| `provider_key`、`provider_type` | `model_providers` | Adapter | 生成 DSH 路由名与适配器选择 |
| `model_key` | `provider_models.model_key` | Adapter、网关 | 模型 id；网关校验请求模型与之一致 |
| `base_url` | `model_providers.base_url` | 网关 | 转发的厂商地址；**不写入 DSH patch** |
| `credential_ref_id` | `credential_refs.id` | 网关 | 解析平台加密保存的厂商密钥；不含密钥值 |
| `trust_level`、`data_policy_version` | `model_providers`、数据防护策略 | 网关 | 数据防护策略（[数据防护方案 5.5](model-data-protection-plan.md#55-provider-信任级别与策略)） |

DSH patch 中的 `baseURL` 固定为网关地址，`apiKeyEnv` 为令牌环境变量名，两者不来自快照。

Adapter 与网关只从 Manifest 读取路由，不在执行时回查数据库，保证同一 Attempt 的重试、PF-04 恢复（[持久化等待服务](../../server/src/modules/run/postgres-persistent-wait-service.ts) 已复制快照）与审计看到同一份配置。

**兼容：** `model_route` 作为 Manifest `1.0` 的可选字段新增，旧记录在现有兼容层（[runtime-manifest-compatibility.ts](../../server/src/modules/runtime/runtime-manifest-compatibility.ts)，目前只处理预算字段）中识别：缺少 `model_route` 的升级前 Attempt 按 Profile 默认模型执行，这是数据兼容，不属于 4.7 所说的失败回退。升级后新创建的 Attempt 必须携带 `model_route`，缺失视为编排缺陷，Attempt 失败。

### 4.3 Provider 类型映射

`model_providers.provider_type` 当前为自由文本，改为枚举并映射到 DSH 适配器：

| `provider_type` | DSH 适配器 | 生成内容 |
| --- | --- | --- |
| `deepseek-official` | `dsh-llm-deepseek`（Profile 已挂载） | 设定 `acp.provider: deepseek-official`、`acp.model`，并把适配器地址指向网关。**能否指向自定义地址待 DLP-S0 验证**；不能时，DeepSeek 改以 `openai-completions` 接入，`deepseek-official` 类型不开放（数据防护方案 D9） |
| `openai-completions` | `dsh-llm-pi-ai` | 声明路由：`api`、`baseURL`（网关）、`apiKeyEnv`（令牌变量）、`models`、`retryPolicy` |
| `openai-responses`、`anthropic-messages` | `dsh-llm-pi-ai` | 同上；首批不开放，探针覆盖后再加入 |

平台声明的 pi-ai 路由名统一加前缀 `dshw-<provider_key>`，避免与 DSH 内置路由同名（pi-ai 对重复注册的路由名在加载时失败）。`retryPolicy` 由平台显式给出：只重试连接错误、408、429 与 5xx，**不重试其他 4xx**（含网关的令牌拒绝与数据防护拒绝），避免与平台 Attempt 重试叠加放大。

### 4.4 每 Attempt patch

当前 `prepareMcpProcess` 在没有 MCP 连接时直接返回，且要求启动参数含 `--profile`（[dsh-acp-runtime-adapter.ts](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts)）。将其泛化为统一的 Attempt patch 生成器，保留 `--profile` 前提，一个文件包含：

1. `settings.path` 指向 Attempt 目录内的平台设置文件（不存在或为空），隔离共享 `DSH_HOME/settings.yaml`；
2. 模型路由（4.3）；
3. `acp.provider` / `acp.model`；
4. 既有 MCP 客户端段落与环境变量。

patch 只含环境变量名，不含令牌或密钥值；敏感值继续沿用 `!!js process.env.X` 注入方式。

Adapter 目前有三条启动 DSH 的路径，只有正式执行使用路由：

| 路径 | 位置 | 是否发出模型请求 | 处理 |
| --- | --- | --- | --- |
| 工具目录探测 | `listTools` | 否，只到 `session/new` | 继续使用基础部署 patch 的默认模型 |
| MCP 连接检查 | `inspectMcpConnection` | 否，只到 `session/new` | 同上 |
| 正式执行 | `execute` | 是 | 使用 Attempt patch；`session-summary` 等系统运行经同一路径，自然使用路由 |

基础部署 patch（[acp-managed-credentials.cordis.yml](../../server/config/dsh/acp-managed-credentials.cordis.yml)）中的 `acp.provider/model` 保留为上述两条探测路径的默认值。网关上线后 `DSH_HOME` 不再保存厂商凭据；探测路径不发出模型请求，不受影响（第 3 节事实 2）。

### 4.5 凭据与令牌（R1：不实施 DSH 侧凭据检查）

原方案第一阶段在 `DSH_HOME` 保留厂商凭据、由 Adapter 检查凭据引用是否存在。按 R1 不实施，改为：

- 厂商密钥由平台使用环境主密钥加密保存，`credential_refs` 记录密文与状态；明文只在网关转发时解析（[数据防护方案 5.2](model-data-protection-plan.md#52-模型网关最小范围)）。`credential_refs.backend` 新增平台加密后端，`dsh-managed` 不再用于新配置。
- Adapter 为每个 Attempt 签发短期令牌，通过环境变量交给 DSH；Attempt 终态即失效。
- 网关在转发前确认凭据存在且状态为 `configured`，缺失时拒绝并以 `MODEL_CREDENTIAL_INVALID` 结束 Attempt（4.7）。因此不再需要原 4.5 的启动前引用检查。

### 4.6 校验与证据

- `session/new` 返回后，`configOptions` 中 `model.currentValue` 必须等于 `JSON.stringify([provider, model])`，否则 Attempt 以 `MODEL_ROUTE_UNAVAILABLE` 失败；
- 网关校验每个请求的模型与快照 `model_key` 一致，不一致即拒绝；
- 终态时以网关记录的实际 provider/model 与 token 用量写入终态事件的 `effective_model` 并用于用量归属；会话日志 `assistant/message.data.message.source` 用于核对，二者或与快照不一致时记录告警事件；
- 管理端运行详情展示路由快照与实际模型；不展示凭据。

### 4.7 失败语义

| 情形 | 结果 |
| --- | --- |
| 无可用 `default` 路由 | 维持现状：Dispatcher 报依赖不可用，不创建 Attempt |
| 模型未在路由中声明 / `currentValue` 不符 / 令牌与路由不符 | Attempt 失败，`MODEL_ROUTE_UNAVAILABLE` |
| 厂商密钥缺失、无效或被吊销（网关检查或厂商 401/403） | Attempt 失败，`MODEL_CREDENTIAL_INVALID` |
| 配额或余额耗尽（厂商明确返回额度类错误） | Attempt 失败，`MODEL_QUOTA_EXHAUSTED` |
| 限流（429，`retryPolicy` 重试后仍失败） | Attempt 失败，`MODEL_RATE_LIMITED` |
| 上游连接失败、超时、5xx | Attempt 失败，`MODEL_UPSTREAM_UNAVAILABLE` |
| 数据防护拒绝 | 见[数据防护方案 5.6](model-data-protection-plan.md#56-拦截与失败语义) |

当前 [classifyRuntimeFailure](../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts) 把模型错误统一归为 `MODEL_INVOCATION_FAILED`。细分以网关记录的上游状态与错误为依据（网关比 DSH 错误文本更可靠）；无法归类的保留 `MODEL_INVOCATION_FAILED`。四类不得合并：管理员与显式重试据此判断是否需要换用 `fallback` 路由，限流与上游故障可以稍后重试，凭据与额度问题需要人工处理。

任何情形都不回退到 Profile 默认模型，也不在 Attempt 内切换到 `fallback`（升级前旧 Manifest 的兼容执行见 4.2，不属于回退）。

### 4.8 推理强度（可选，后做）

路由增加可选 `reasoning_effort`。`session/new` 后，若 `configOptions` 中存在 `reasoning_effort` 且包含该值，调用 `session/set_config_option`；不存在时 Attempt 失败而不是静默忽略。需先补充探针验证。

### 4.9 路由用途（R2）

- `model_routes.purpose` 只允许 `default` 与 `fallback`；现有 `chat`、`analysis` 数据迁移为停用的 `fallback` 路由，由管理员确认后启用或删除。
- `default`：每个租户最多一条启用（沿用现有唯一索引）。新建 Run 与普通重试使用它。
- `fallback`：可有多条，按 `priority` 排序。只在**显式重试**时使用：管理员或员工在失败的运行上选择“换用备用模型重试”，平台用所选 `fallback` 路由新建 Attempt，快照记录 `purpose: fallback`。该入口只对 4.7 中的 `MODEL_CREDENTIAL_INVALID`、`MODEL_QUOTA_EXHAUSTED`、`MODEL_RATE_LIMITED`、`MODEL_UPSTREAM_UNAVAILABLE` 开放。
- `resolveRoute` 的能力校验（`ModelCapabilityMismatchError`）对两种用途一致适用。

### 4.10 治理补强

- Provider 类型改为枚举选择；Provider 增加 `trust_level`（`internal` / `external`，[数据防护方案 5.5](model-data-protection-plan.md#55-provider-信任级别与策略)），新建时必选，存量迁移为 `external`。
- 路由可编辑名称、目标模型、优先级与启停；模型可单独启停；Provider 与模型停用时，引用它们的路由在解析时视为不可用。
- 修改或停用路由只影响之后新建的 Attempt；进行中的 Attempt 使用已固定的快照运行至终态。
- 管理端去掉“仅记录”提示，改为说明路由经网关生效；凭据配置改为录入厂商密钥（只写不读，保存后不回显）。

## 5. 改动范围

| 区域 | 文件 | 改动 |
| --- | --- | --- |
| Manifest | `server/src/modules/runtime/runtime-types.ts`、`manifest-compiler.ts`、`runtime-manifest-compatibility.ts`、[runtime-manifest.schema.json](../development/runtime-manifest.schema.json) | 新增可选 `model_route`，旧版本兼容 |
| 编排 | `server/src/modules/run/orchestration/attempt-dispatcher.ts` | 写入路由快照；显式重试可指定 `fallback` 路由 |
| Adapter | `server/src/modules/runtime/dsh-acp-runtime-adapter.ts` | 统一 Attempt patch 生成器、令牌签发与注入、`currentValue` 校验、模型错误细分 |
| ACP 客户端 | `server/src/modules/runtime/acp-json-rpc-client.ts` | `newSession` 返回 `configOptions`；4.8 时新增 `setConfigOption` |
| 模型网关 | 新模块（[数据防护方案 5.2](model-data-protection-plan.md#52-模型网关最小范围)） | 令牌校验、转发、计量、上游错误记录 |
| DSH 配置 | `server/config/dsh/acp-managed-credentials.cordis.yml` | 默认值保留给探测路径，注释说明被 Attempt patch 覆盖 |
| Model 模块 | `server/src/modules/model/model-types.ts`、`model-governance-service.ts`、仓储 | `provider_type` 枚举、`trust_level`、用途收敛、路由编辑与模型启停、平台加密凭据 |
| 管理端 | `apps/admin-web/src/views/ModelGovernanceView.vue` | 类型与信任级别选择、路由编辑、模型启停、密钥录入；运行详情展示实际模型；失败运行的“换用备用模型重试” |
| 数据 | SQL 迁移 | `provider_type`、`trust_level`、`purpose` 约束；`chat`/`analysis` 迁移；默认路由种子为 `deepseek-official/deepseek-v4-pro` |
| 文档 | [总览](../development/overview.md) 3.5、4.4、第 10 节；[内部端口与契约](../development/internal-ports.md)；[Runtime 指南](../release/dsh-runtime-delivery.md)；`deploy/runtime.env.example`；功能规则（显式重试） | 删除“路由只记录不生效”，补充网关、凭据与重试说明 |

不改动：启动检查（`dsh-runtime-installation.ts`）与两条探测路径继续使用基础默认模型。

## 6. 风险

| 风险 | 处理 |
| --- | --- |
| 共享 `settings.yaml` 覆盖平台路由 | 每 Attempt 隔离 `settings.path`（已实测有效）；DSH Models 页面写入不再影响平台运行，需在 Runtime 指南中说明 |
| `dsh-llm-deepseek` 不能指向网关 | DLP-S0 先验证；不能时按 4.3 改走 `openai-completions` |
| 路由生效要等网关建好（R1 的代价） | MR-S1 可先行；MR-S2 与 DLP-S1 同批交付，分期见第 9 节 |
| pi-ai 协议兼容性差异（流式、工具调用、思考格式） | 首批只开放 `deepseek-official`（视 DLP-S0）与 `openai-completions`；每接入一个厂商须 P2 留证 |
| DSH 内置 `workflow` 工具参数允许按阶段覆盖 provider/model | 该工具不在[内置工具注册表](../../server/src/modules/runtime/builtin-tools.ts)，现被策略拒绝；放行前须评审；网关按快照校验模型，越权请求会被拒绝 |
| 双层重试放大请求量 | 路由 `retryPolicy` 由平台显式设置，不重试其他 4xx |
| 厂商错误文本各异，细分不准 | 以网关记录的状态码与错误码为准；无法归类时保留 `MODEL_INVOCATION_FAILED`；P2 补充真实厂商样本 |
| DSH 升级后插件 id 或配置字段变化 | 纳入 DSH 升级准入检查：路由声明、`settings.path`、日志 `source` 字段、适配器地址 |

## 7. 模型网关（与路由生效同批实施）

pi-ai 路由的 `baseURL` 指向平台模型网关，`apiKeyEnv` 为本 Attempt 的短期令牌；网关校验令牌后用平台加密保存的密钥转发，并在网关侧计量。DSH 中不持有任何模型凭据。网关只做认证、转发、计量与数据防护，不承担任何 Agent 执行逻辑；详细设计、令牌、拒绝传递与数据防护见[发往模型的数据防护方案](model-data-protection-plan.md)第 5 节。

原方案把网关列为第二阶段，并与[执行隔离方案](execution-isolation-plan.md)第 10 节的后续方向对齐。按 R1 与数据防护方案 D1，网关提前与路由生效同批实施。执行隔离方案的判断仍然成立：执行容器的环境变量由执行器固定，网关不是放开可执行能力的前提；它缓解的是 DSH 本身被攻破时的长期凭据暴露，并为数据防护提供唯一的请求通道。

## 8. 验证

| 层级 | 内容 |
| --- | --- |
| 单元 | patch 生成（有/无 MCP、各 `provider_type`、缺 `--profile` 拒绝）、令牌注入不含值、`currentValue` 不符失败、模型错误细分、`fallback` 只在显式重试中解析、旧 Manifest 兼容、用途与信任级别校验 |
| P1 集成 | 受控 DSH + 网关 + 本地 OpenAI 兼容假上游（或 `dsh-llm-mock-server`）：路由生效、模型未声明、共享 `settings.yaml` 存在同名路由、网关令牌越权被拒、密钥缺失以 `MODEL_CREDENTIAL_INVALID` 结束、429 重试后以 `MODEL_RATE_LIMITED` 结束且 4xx 不被重试、`fallback` 显式重试新建 Attempt 并记录用途、探测路径不发出模型请求、停用路由不影响进行中 Attempt |
| P2 真实验收 | 目标 DSH 版本下，在 DeepSeek 官方与另一家外部厂商（R3，P2 前确定）之间切换 `default` 路由：新 Attempt 的上游请求、网关记录、会话日志 `source` 与用量统计均指向新模型；按 [PF-07 验收手册](../development/pf07-platform-acceptance.md) 留证 |

Mock 或 P1 通过不能代替 P2，未完成 P2 前总览仍须标注路由生效“未真实验收”。

## 9. 分期

| 阶段 | 内容 | 依赖 | 完成标志 |
| --- | --- | --- | --- |
| MR-S1 治理数据补强 | `provider_type` 枚举、`trust_level`、用途收敛与数据迁移、路由编辑与模型启停（4.9、4.10 中不涉及执行的部分）；不改变执行行为 | 无，可先行 | 管理端与接口用例通过；执行仍按 Profile 默认模型 |
| DLP-S0 探针 | 见数据防护方案第 7 节；本方案关心 `dsh-llm-deepseek` 能否指向网关、4xx 重试行为 | 无 | 4.3 的 `deepseek-official` 映射定论 |
| MR-S2 + DLP-S1 路由生效与网关 | Manifest `model_route`、统一 Attempt patch、令牌、`currentValue` 校验、网关转发与计量、平台加密凭据、模型错误细分 | MR-S1、DLP-S0 | 所有正式执行经网关，路由决定实际模型；P1 通过 |
| MR-S3 证据与展示 | `effective_model` 与用量归属、运行详情、`fallback` 显式重试入口、文档更新 | MR-S2 | P1 与管理端用例通过 |
| MR-P2 真实验收 | 第 8 节 P2 | MR-S3 | 留证完成，总览去掉“未真实验收” |

数据防护的识别与还原（DLP-S2）在网关链路上叠加，不阻塞 MR-S2/S3。
