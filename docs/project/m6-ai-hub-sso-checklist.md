# M6 AI Hub SSO 接入检查清单

## 代码与数据库

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| OIDC Authorization Code + PKCE | 已完成 | `server/src/modules/identity/oidc-client.ts` |
| `state` / `nonce` / JWT / scope 校验 | 已完成 | `server/src/modules/identity/auth-service.ts` |
| AI Hub `/me` / `/me/permissions` / 在线决策 | 已完成 | `server/src/modules/identity/ai-hub-client.ts` |
| 服务端 Session 与 Token 加密存储 | 已完成 | `server/migrations/0014_m6_ai_hub_sso.sql`、`secure-values.ts` |
| 旋转 Refresh Token 并发互斥 | 已完成 | `IdentitySessionRepository.refreshTokensWithLock` 与 PostgreSQL advisory lock 集成测试 |
| 应用级角色与数据范围隔离 | 已完成 | `0015_m6_identity_grant_sources.sql`、Session 角色/范围授权上下文 |
| Workbench/Admin API 统一鉴权 | 已完成 | `server/src/http/router.ts` |
| 管理读取与审计读取按路由隔离 | 已完成 | Router 服务端校验、前端路由/导航/数据加载权限测试 |
| 去除浏览器传入 `actor` / 硬编码用户 | 已完成 | Workbench/Admin routes 与前端 API client |
| 上传人持久化 | 已完成 | `file_objects.uploaded_by` 与 `PostgresContentService` |
| 前端自动登录、退出、无权限/失败页 | 已完成 | 两个 Web 应用的 router/auth store |
| 本地 `/auth` 代理与 Cookie 携带 | 已完成 | 两个 Vite config 与 API client |
| 健康检查 | 已完成 | `GET /health/live` |
| OIDC/JWKS/PKCE/密文单测 | 已完成 | `pnpm test:sso` |
| PostgreSQL 迁移与 Session Repository 集成测试 | 已完成 | `pnpm test:sso:integration` |
| M6 SSO 工程 Gate 与 CI | 已完成 | `pnpm verify:m6:sso`、GitHub Actions PostgreSQL Job |

## AI Hub 与部署操作

| 项目 | 状态 | 责任人/证据 |
| --- | --- | --- |
| 注册 `dsh-work` 应用与环境 | 待平台管理员执行 | AI Hub 应用中心截图/导出 |
| 登记 Workbench/Admin 两个回调 | 待平台管理员执行 | 环境详情 |
| 分配 Platform OAuth Scope | 待平台管理员执行 | `platform.me.read`、`platform.authorization.decide` |
| 创建凭据并存入 Secret Manager | 待平台管理员执行 | 不记录 Secret 明文 |
| 登记 `dsh_work.*` 权限、角色和用户授权 | 待平台管理员执行 | AI Hub 权限与安全 |
| 配置生产 HTTPS/反向代理/Secure Cookie | 待运维执行 | 部署变更单 |
| 执行账号、权限收回、AI Hub 故障验收 | 待联调 | UAT 记录 |
| AI Hub `API_ONLY` 接入认证 | 待联调 | 接入治理证据 |

具体填写值、权限表和验收步骤见 [`docs/deployment/ai-hub-sso-integration.md`](../deployment/ai-hub-sso-integration.md)。
