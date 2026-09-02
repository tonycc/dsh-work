# M6 AI Hub 身份接入检查清单

## 代码与数据库

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| OIDC Authorization Code + PKCE、`state`、`nonce`、JWT、Issuer、Audience 与 Scope 校验 | 已完成 | `server/src/modules/identity/oidc-client.ts`、`auth-service.ts` |
| 员工端与管理端共用一个 AI Hub 应用环境凭据 | 已完成 | `server/src/modules/identity/config.ts` 配置失败关闭 |
| AI Hub `/me` 只建立稳定外部身份映射 | 已完成 | `ai-hub-client.ts`、`IdentitySessionRepository.synchronizeIdentity` |
| 环境初始管理员一次性认领本地平台管理员 | 已完成 | AI Hub `admin-bootstrap` + `application_admin_bootstrap_claims` |
| AI Hub 员工目录增量/全量同步与 Tombstone 停用 | 已完成 | `IdentityDirectorySyncService`、`identity_directory_sync_state` |
| 员工同步不修改角色、权限和数据范围 | 已完成 | `0016_identity_owned_authorization.sql`、PostgreSQL 集成测试 |
| 角色、功能权限与数据范围由 dsh-work 本地管理 | 已完成 | `IdentityAdministrationService`、管理 API 和“员工与权限”页面 |
| 本地授权版本触发器与 Session 即时重算 | 已完成 | `local_authorization_version`、角色/范围触发器、`authenticateApi` |
| AI Hub `/me/permissions`、在线决策与 `dsh_work.*` 授权来源已移除 | 已完成 | 源码/文档静态 Gate、0016 清理迁移 |
| 最后一位平台管理员防误删 | 已完成 | `requireAnotherPlatformAdmin` 集成保护 |
| 服务端 Session、Token 加密和 Refresh Token 并发互斥 | 已完成 | `0014_m6_ai_hub_sso.sql`、`SecretBox`、PostgreSQL advisory lock |
| Workbench/Admin API 统一使用本地授权 | 已完成 | `server/src/http/router.ts`、`PostgresAuthorizationService` |
| 浏览器不能传入用户、角色、数据范围或操作人 | 已完成 | HttpOnly Session、服务端 `RequestIdentity` 注入 |
| 自动登录、退出、无权限/失败状态与本地授权指引 | 已完成 | 两个 Web 应用 router/auth store/views |
| OIDC/JWKS/PKCE/密文单测 | 已完成 | `pnpm test:sso` |
| PostgreSQL 身份映射、Bootstrap、本地授权与 Session 集成测试 | 已完成 | `pnpm test:sso:integration` |
| 身份工程 Gate 与 CI | 已完成 | `pnpm verify:m6:sso`、GitHub Actions PostgreSQL Job |

## AI Hub 与部署操作

| 项目 | 状态 | 责任人/证据 |
| --- | --- | --- |
| 创建或升级唯一 `dsh-work` 应用与目标环境 | 待平台管理员执行 | AI Hub 应用中心截图/导出 |
| 从员工目录选择应用负责人，并为环境独立指定首位 dsh-work 管理员 | 待平台管理员执行 | 应用详情、环境 Bootstrap 状态与首登审计 |
| 登记 Workbench/Admin 两个严格回调 | 待平台管理员执行 | 环境详情 |
| 凭据包含 `platform.me.read`、`platform.application.bootstrap`、`platform.directory.read` | 待平台管理员执行 | 凭据 Scope 导出；不记录 Secret |
| 创建/轮换凭据并存入 Secret Manager | 待平台管理员执行 | Secret 引用与轮换记录 |
| 不登记 `dsh_work.*` 权限、AI Hub 应用角色或数据范围 | 待联调确认 | AI Hub 应用配置核对 |
| 配置生产 HTTPS、反向代理、Secure Cookie 与目录同步间隔 | 待运维执行 | 部署变更单 |
| 首位管理员登录并再配置至少一名平台管理员 | 待联调 | dsh-work 审计记录 |
| 执行员工同步、授权变更、停用、Session 撤销和 AI Hub 故障验收 | 待联调 | UAT 记录 |
| AI Hub `OIDC_ONLY` 接入认证 | 待联调 | 接入治理证据 |

具体填写值、边界和验收顺序见 [`docs/deployment/ai-hub-sso-integration.md`](../deployment/ai-hub-sso-integration.md)。
