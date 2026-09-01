# dsh-work MVP 数据模型（M0 基线）

版本：V0.3
数据库：PostgreSQL
状态：逻辑模型与 M2 物理 DDL 已冻结；迁移位于 `server/migrations`

## 1. 建模原则

- 所有业务数据均带 `tenant_id`；任何查询必须先限定租户，再应用角色和数据范围。
- 用户只来自 AI Hub OIDC，同一企业内通过稳定的 `external_subject` 关联；员工端与管理端使用独立的本地 Session 受众。
- 每位用户自动拥有且只能拥有一个个人工作空间；所有 Session、文件和成果必须归属个人或团队工作空间，`workspace_id` 不可为空。
- 对话是员工工作对象；管理端 Session 页面仅用于状态、用量、安全与审计治理，不建设可任意浏览全量消息的页面。
- Agent、Skill 和 Runtime 配置使用不可变版本或变更快照；已运行任务可回溯到执行时配置。
- 删除优先软删除或归档；审计事件和成果版本不可原地覆盖。

## 2. 核心关系

```mermaid
erDiagram
  TENANT ||--o{ USER : contains
  USER ||--o{ USER_ROLE : assigned
  USER ||--o{ AUTHENTICATION_SESSION : authenticates
  ROLE ||--o{ USER_ROLE : grants
  TENANT ||--o{ WORKSPACE : owns
  WORKSPACE ||--o{ WORKSPACE_MEMBER : has
  USER ||--o{ WORKSPACE_MEMBER : joins
  USER ||--o{ SESSION : creates
  WORKSPACE ||--o{ SESSION : scopes
  AGENT ||--o{ AGENT_VERSION : versions
  USER ||--o{ AGENT : owns
  AGENT_VERSION ||--o{ SESSION : selected_by
  SESSION ||--o{ MESSAGE : contains
  SESSION ||--o{ RUN : executes
  RUN ||--o{ RUN_ATTEMPT : retries
  RUN_ATTEMPT ||--o{ RUN_EVENT : emits
  SESSION ||--o{ ARTIFACT : produces
  ARTIFACT ||--o{ ARTIFACT_VERSION : versions
  WORKSPACE o|--o{ FILE_OBJECT : shares
  SESSION o|--o{ FILE_OBJECT : attaches
  FILE_OBJECT ||--o{ FILE_EXTRACTION : parses
  RUN_ATTEMPT ||--o{ RUN_INPUT_FILE : snapshots
  FILE_OBJECT ||--o{ RUN_INPUT_FILE : mounted_as
  TENANT ||--o{ AUDIT_EVENT : records
```

## 3. 表与关键字段

### 3.1 身份与权限

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `tenants` | `id`, `name`, `status` | 企业租户根对象 |
| `users` | `id`, `tenant_id`, `external_subject`, `display_name`, `department_id`, `status` | `unique(tenant_id, external_subject)`；不存 SSO 密码 |
| `roles` | `id`, `tenant_id`, `code`, `name`, `permissions` | `code` 在租户内唯一；权限采用受控枚举 |
| `user_roles` | `tenant_id`, `user_id`, `role_id`, `source_key`, `valid_until` | 联合主键包含授权来源；本地授权使用 `local`，AI Hub 授权按 Audience 与应用隔离 |
| `data_scope_grants` | `id`, `tenant_id`, `subject_type`, `subject_id`, `scope_code`, `scope_value` | 主体可为用户、角色或 Workspace；MVP 以 `scope_value` 保存受控完整范围代码 |
| `oidc_login_transactions` | `transaction_hash`, `audience`, `state_hash`, `code_verifier_encrypted`, `nonce`, `return_to`, `expires_at` | 一次性 OIDC 登录交易；使用后原子删除 |
| `authentication_sessions` | `session_hash`, `tenant_id`, `audience`, `user_id`, `access_token_encrypted`, `refresh_token_encrypted`, `token_expires_at`, `authorization_version`, `permissions`, `data_scopes`, `expires_at`, `revoked_at` | 浏览器只保存不透明 Cookie；AI Hub Token 加密存储，不返回前端 |

服务端授权顺序固定为：启用租户/用户 → 当前 Session 所属 AI Hub 应用的未过期角色与入口权限 → 个人空间所有者或团队空间成员 → Session 锁定的 Agent 已发布版本/可见角色 → 当前应用数据范围覆盖 → 团队工作空间 Agent/Skill/Tool 精确版本授权 → Tool 状态、连接器健康和调用权限。个人空间只是用户内容边界，沿用用户与 Agent 的有效权限，不产生新的数据授权；任一环节失败都默认拒绝并写入 `audit_events`。

管理员与审计员仍使用 AI Hub 统一登录，但只有应用授权快照含 `dsh_work.admin.read` / `dsh_work.admin.write` / `dsh_work.audit.read` 时才能进入对应能力。

### 3.2 个人与团队工作空间

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `workspaces` | `id`, `tenant_id`, `name`, `description`, `workspace_type`, `created_by`, `status`, `archived_at` | `workspace_type` 为 `personal/team`；每个用户最多一个始终启用的个人空间 |
| `workspace_members` | `workspace_id`, `user_id`, `member_role`, `added_by`, `joined_at` | 联合主键；个人空间只允许所有者本人，团队成员角色为 `owner/admin/member/viewer` |
| `workspace_capability_grants` | `workspace_id`, `capability_type`, `capability_version_id` | 团队空间绑定允许使用的 Agent/Skill/工具精确版本；无授权记录时默认拒绝 |

用户创建或首次使用时由服务端幂等确保默认“我的空间”，个人空间不能加入其他成员、归档或扩大企业权限。团队空间创建者默认成为 `owner`，但空间属于企业租户；创建者离职或移除前必须转移至少一个 owner。

### 3.3 Agent、Skill、工具与连接器

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `agents` | `id`, `tenant_id`, `name`, `description`, `welcome_message`, `owner_user_id`, `created_by`, `status` | 创建者自动成为负责人，创建页不显示负责人字段 |
| `agent_versions` | `id`, `agent_id`, `version`, `system_prompt`, `visible_role_ids`, `data_scopes`, `status`, `published_at` | 不包含 Agent 级模型策略；发布后不可变 |
| `agent_version_skills` | `agent_version_id`, `skill_version_id` | 精确绑定 Skill 版本 |
| `agent_version_tools` | `agent_version_id`, `tool_version_id` | 一期仅允许平台预置工具 |
| `skills` | `id`, `tenant_id`, `key`, `name`, `owner_user_id`, `status` | `key` 由名称生成并保证租户内唯一，创建后稳定 |
| `skill_versions` | `id`, `skill_id`, `version`, `instructions`, `manifest`, `status` | 发布后不可变 |
| `tools` | `id`, `tenant_id`, `key`, `name`, `source`, `status` | 一期 `source=platform`，管理端只读 |
| `tool_versions` | `id`, `tool_id`, `version`, `input_schema`, `output_schema`, `risk_level` | 工具契约版本化 |
| `connectors` | `id`, `tenant_id`, `key`, `name`, `connector_type`, `credential_ref`, `status` | 一期只使用预置连接器；只存凭据引用 |

### 3.3.1 Provider、模型路由与密钥引用

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `credential_refs` | `id`, `tenant_id`, `backend`, `external_ref`, `status`, `last_verified_at` | 只保存外部密钥引用和状态，不保存密钥正文 |
| `model_providers` | `id`, `tenant_id`, `key`, `provider_type`, `base_url`, `credential_ref_id`, `status` | Provider 属于平台治理，不进入 Agent 配置 |
| `provider_models` | `id`, `tenant_id`, `provider_id`, `model_key`, `capabilities`, `status` | 模型在 Provider 内唯一 |
| `model_routes` | `id`, `tenant_id`, `key`, `purpose`, `provider_model_id`, `priority`, `enabled` | 每租户只允许一个启用的默认路由；运行前解析 |

MVP 当前种子路由为 `deepseek-official / deepseek-v4-pro`，凭据引用为 DSH 受管的 `DEEPSEEK_API_KEY`。dsh-work 不读取或复制该密钥。M3 创建 Attempt 时把解析结果（Provider、模型、Base URL 和凭据引用，不含密钥）写入 `run_attempts.model_route_snapshot`，从而保证运行可追溯且不受后续路由修改影响。

### 3.4 对话、运行与事件

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `sessions` | `id`, `tenant_id`, `workspace_id`, `created_by`, `agent_version_id`, `title`, `status`, `last_active_at` | `workspace_id` 非空；未显式选择团队空间时自动使用创建人的个人空间 |
| `messages` | `id`, `session_id`, `role`, `content`, `content_classification`, `created_at` | `role` 为 `user/assistant/system/tool`；不持久化隐藏推理 |
| `runs` | `id`, `session_id`, `requested_by`, `idempotency_key`, `status`, `current_attempt_id`, `created_at` | `unique(session_id, requested_by, idempotency_key)` |
| `run_attempts` | `id`, `run_id`, `attempt_no`, `runtime_id`, `manifest`, `status`, `started_at`, `ended_at`, `error_code` | 每次重试新增记录；`unique(run_id, attempt_no)` |
| `run_events` | `id`, `run_id`, `attempt_id`, `sequence`, `event_type`, `display_message`, `safe_metadata`, `trace_id`, `occurred_at` | `unique(attempt_id, sequence)` 与 `unique(id)`；符合事件 Schema |
| `approvals` | `id`, `run_id`, `event_id`, `requested_action`, `risk_level`, `status`, `resolved_by`, `resolved_at` | 高风险工具调用必须关联审批 |

Run 状态：

```text
queued → running → completed
              ├→ failed → retry（新 Attempt）
              └→ cancel_requested → cancelled
queued ───────────────────────────→ cancelled
```

完成、失败、取消对当前 Attempt 都是终态，终态 Attempt 不可回退。Run 的普通状态转换同样不得从终态回退；唯一例外是显式“失败重试”命令在同一事务中创建新 Attempt 并把 Run 重新排队，原失败 Attempt 保持不可变。已成功或已取消的 Run 不接受重试。

### 3.5 Runtime、文件、成果、用量与审计

| 表 | 关键字段 | 约束与说明 |
|---|---|---|
| `runtimes` | `id`, `tenant_id`, `node_name`, `runtime_version`, `status`, `capacity`, `last_heartbeat_at` | Runtime 是可调度执行实例，不等同于单个 DSH 子进程 |
| `runtime_configurations` | `tenant_id`, `runtime_id`, `revision`, `concurrency_limit`, `timeout_seconds`, `sandbox_policy`, `updated_by` | 每个 Runtime 独立追加配置版本；历史不覆盖；每次修改写审计 |
| `operational_events`（只读视图） | `category`, `action`, `object_type`, `object_id`, `actor_id`, `result`, `trace_id`, `run_id`, `attempt_id`, `safe_context` | 合并管理、安全、运行、模型、工具和成果事件；严禁投影消息、提示词、回答正文和文件内容 |
| `file_objects` | `id`, `tenant_id`, `workspace_id`, `session_id`, `uploaded_by`, `storage_key`, `original_name`, `mime_type`, `size_bytes`, `sha256`, `scan_status` | `uploaded_by` 只由服务端 Session 注入；下载前同时按个人所有者或团队成员关系鉴权 |
| `file_extractions` | `id`, `file_id`, `extractor_version`, `detected_type`, `status`, `text_storage_key`, `text_sha256`, `character_count`, `page_count`, `sheet_count`, `row_count`, `error_code` | 原文件解析结果版本化；成功记录摘要和统计，失败记录可操作错误码 |
| `run_input_files` | `id`, `run_id`, `attempt_id`, `file_id`, `extraction_id`, `mount_path` | 固化每个 Attempt 使用的原文件、解析版本和只读挂载路径；重试新增快照 |
| `artifacts` | `id`, `tenant_id`, `workspace_id`, `session_id`, `name`, `artifact_type`, `created_by` | 成果逻辑对象 |
| `artifact_versions` | `id`, `artifact_id`, `version_no`, `file_object_id`, `source_run_id`, `created_at` | 只新增版本，不覆盖 |
| `knowledge_sources` | `id`, `tenant_id`, `key`, `source_type`, `status`, `synthetic` | 企业知识来源登记；合成基线必须显式标记 |
| `knowledge_documents` | `id`, `source_id`, `document_key`, `version`, `effective_date`, `content_checksum`, `allowed_role_ids`, `allowed_workspace_ids`, `status` | 已发布知识版本不可原地修改，检索前执行权限过滤 |
| `run_knowledge_sources` | `run_id`, `attempt_id`, `document_id`, `relevance_score`, `excerpt` | 固化每个 Attempt 实际使用的知识版本与摘要 |
| `model_usage_events` | `id`, `tenant_id`, `run_id`, `provider`, `model`, `input_tokens`, `output_tokens`, `cost_amount`, `occurred_at` | Token 原始计量事件；费用币种另存 |
| `audit_events` | `id`, `tenant_id`, `actor_type`, `actor_id`, `action`, `object_type`, `object_id`, `result`, `trace_id`, `safe_context`, `occurred_at` | 追加写；授权通过/拒绝使用 `object_type=authorization`；敏感值脱敏；不可由普通管理员删除 |

## 4. 索引基线

- `sessions(tenant_id, created_by, last_active_at desc)` 与 `sessions(tenant_id, workspace_id, last_active_at desc)`。
- `runs(session_id, created_at desc)`、`run_attempts(run_id, attempt_no desc)`。
- `run_events(attempt_id, sequence)`，用于 SSE 断点续传。
- `runtime_configurations(tenant_id, runtime_id, revision desc)` 与 `run_attempts(tenant_id, runtime_id, status, created_at)`，用于读取最新运维策略和原子容量调度。
- `workspace_members(user_id, workspace_id)`，用于员工工作空间列表。
- `artifacts(tenant_id, workspace_id, created_at desc)` 与 `artifacts(session_id, created_at desc)`。
- `file_extractions(tenant_id, file_id, created_at desc)` 与 `run_input_files(tenant_id, run_id, attempt_id)`。
- `audit_events(tenant_id, occurred_at desc)`、`audit_events(trace_id)`、`audit_events(object_type, object_id)`。
- `model_usage_events(tenant_id, occurred_at)` 和 `model_usage_events(run_id)`。

所有唯一约束都必须包含 `tenant_id` 或通过父对象外键保证租户隔离。

## 5. 页面—API—数据映射

| 页面 | 主要 API | 主要表 | MVP 验收点 |
|---|---|---|---|
| 员工工作台 | `GET /session`、`POST /sessions` | `users`, `workspaces`, `sessions` | 默认选择“我的空间”；服务端在未传空间时仍自动补齐个人空间 |
| 对话页 | `POST /sessions/{id}/files`、`POST /sessions/{id}/runs`、SSE Events、取消/重试 | `messages`, `runs`, `run_attempts`, `run_events`, `file_objects`, `file_extractions`, `run_input_files` | 输入框固定底部；文件先解析再形成只读 Attempt 快照；刷新可恢复；失败可重试 |
| 工作空间页 | `GET /workspaces`、文件上传 | `workspaces`, `workspace_members`, `file_objects` | 同时展示唯一个人空间与已加入团队空间；详情使用列表响应中的空间、文件和用量数据 |
| 成果库 | `/artifacts`、下载 | `artifacts`, `artifact_versions` | 仅可下载有权限的版本 |
| Agent 管理 | `/agents`、测试、发布 | `agents`, `agent_versions` | 负责人自动为创建者；欢迎语可空；无模型策略字段 |
| 能力管理 | `/skills`、`/tools`、`/connectors` | Skill/工具/连接器表 | Skill 标识自动生成；一期工具和连接器只读 |
| Runtimes | `/runtimes`、`/runtimes/configuration` | `runtimes`, `runtime_configurations` | 位于安全与运维；健康、容量和配置可追溯 |
| Session 治理 | `GET /sessions` | `sessions`, `runs`, `model_usage_events`, `audit_events` | 只展示列表响应中的治理元数据，不提供完整业务消息浏览或单 Session 详情接口 |
| 工作空间管理 | `GET /workspaces` | `workspaces`, `workspace_members`, `sessions`, `artifacts`, `file_objects` | 管理端只读查看团队空间与真实用量；个人空间和成员关系不在管理端开放管理 |

## 6. 保留与脱敏基线

- 具体保留天数由 D-07 确认；MVP 实现必须支持按数据类别配置，不把天数写死在代码中。
- 运行事件只保存可展示内容与安全元数据；模型隐藏推理不进入数据库、日志或 SSE。
- 文件在进入 Runtime 前必须完成类型、大小、病毒扫描和访问鉴权。
- 连接器凭据、模型密钥只保存密钥系统引用；错误信息不得回显凭据或完整请求头。
- 管理员查看 Session 内容属于敏感访问，应默认关闭；若后续启用，必须独立授权并写审计。

## 7. M2 物理模型出口条件

M2 创建迁移脚本前，必须完成 D-03（SSO）、D-06（数据分级）、D-07（保留周期）和 D-08（超级管理员入口）的企业确认；未确认项使用配置占位，不得形成不可逆硬编码。

M2 已按上述规则使用可替换引用和配置字段承接未决项：身份只保存 `external_subject`，文件只保存 `storage_key`，保留周期进入 `system_settings`，业务用户表不保存密码。M6 已用 AI Hub OIDC 和服务端加密 Session 关闭 D-03 的代码实现项；真实应用凭据、权限分配和生产参数仍按部署环境注入。
