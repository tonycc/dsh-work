# dsh-work 接入 AI Hub SSO

## 1. 对接结果

dsh-work 使用 AI Hub 提供的 OIDC 授权码模式，员工工作台和管理后台共用同一个 AI Hub 应用环境凭据，但使用两个严格匹配的回调地址和两个独立的 HttpOnly Session Cookie。

```text
浏览器 → dsh-work /auth/{workbench|admin}/login
       → AI Hub authentik 登录与授权
       → dsh-work /auth/{workbench|admin}/callback
       → 服务端验签并调用 /platform-api/v1/me 与 /me/permissions
       → PostgreSQL 加密保存 Token，浏览器只保存不透明 Session Cookie
```

已实现的安全边界：

- Authorization Code + PKCE，并校验 `state` 和 ID Token `nonce`。
- 本地校验 JWT 的 RS256 签名、`issuer`、`audience`、`exp`、`iat`、`scope` 和 AI Hub 授权版本。
- JWKS 正常缓存 5 分钟，AI Hub 短时不可用时最多使用 1 小时的已缓存公钥。
- Access/Refresh Token 使用 AES-256-GCM 加密后存入 PostgreSQL，不返回前端。
- 登录请求包含 `offline_access`；AI Hub 管理的 Authentik Provider 也必须映射该 Scope，才能在 5 分钟 Access Token 到期后继续使用旋转 Refresh Token。
- 同一 Session 的令牌刷新使用 PostgreSQL 事务级互斥，多个并发 API 请求只会刷新一次。
- 管理写操作需要 `dsh_work.admin.write`，且默认调用 AI Hub 在线授权决策；AI Hub 不可用时失败关闭。
- 业务 API 中的用户和操作人只来自服务端 Session，不接受浏览器传入的 `userId` 或 `actor`。

## 2. AI Hub 环境表单如何填写

本地 dsh-work 运行端口为：员工端 `4174`、管理端 `4180`、服务端 `4190`。在 AI Hub「配置应用环境」中填写：

| 字段 | 本地建议值 | 说明 |
| --- | --- | --- |
| 环境标识 | `local` | 环境稳定标识；测试和生产分别用 `staging` / `production` |
| 版本 | `0.1.0` | 语义版本，与当前 dsh-work 接入版本一致 |
| 门户入口 | `http://localhost:4174/workbench` | AI Hub 中点击应用时打开的主入口 |
| API 地址 | `http://host.docker.internal:4190/api` | AI Hub 以 Docker 运行时访问宿主机 dsh-work；AI Hub 原生运行时改为 `http://localhost:4190/api` |
| 健康检查 | `http://host.docker.internal:4190/health/live` | 返回 `{"status":"ok","service":"dsh-work","version":"0.1.0"}` |
| OIDC 回调地址 | 见下方两行 | 必须严格匹配，不加尾部 `/`，不含 Fragment |
| 状态 | 启用 | 应用、环境、凭据都必须是 `ACTIVE` |

OIDC 回调地址文本框中每行填一个：

```text
http://localhost:4190/auth/workbench/callback
http://localhost:4190/auth/admin/callback
```

`host.docker.internal` 只用于 AI Hub 容器访问宿主机服务；OIDC 回调是浏览器访问，仍使用 `localhost:4190`。Linux Docker 如果没有 `host.docker.internal`，需为 AI Hub backend 配置 host-gateway 别名，或换成容器可达的 dsh-work 地址。

使用 `host.docker.internal` 时，dsh-work 需设置 `DSH_WORK_SERVER_HOST=0.0.0.0`；如果 AI Hub 也是宿主机原生进程，可继续绑定 `127.0.0.1` 并在表单中使用 `localhost:4190`。

## 3. AI Hub 中必须完成的配置

### 3.1 注册应用与 Scope

在「应用中心」注册：

- 应用编号：`dsh-work`
- 接入能力：`API_CLIENT`
- OAuth Scope：`platform.application.read`、`platform.me.read`、`platform.notification.request` 和 `platform.authorization.decide`

`openid`、`profile`、`email`、`offline_access` 和 `ai_hub.identity` 会在 AI Hub 创建或更新凭据时加入 OIDC Provider，不需登记成 dsh-work 的自定义权限点。已有凭据也要执行一次 Scope 更新或轮换，确保 Provider 已补上 `offline_access` 映射。

### 3.2 创建环境凭据

保存环境后，在「密钥管理」为 `local` 创建凭据。AI Hub 只展示一次 `client_secret`，需立即存入密钥管理系统或本地 `.env`，不得提交到 Git。记录弹窗中的：

- `Client ID` → `AI_HUB_CLIENT_ID`
- `Client Secret` → `AI_HUB_CLIENT_SECRET`
- `Issuer` → `AI_HUB_OIDC_ISSUER`

两个前端共用这一套凭据，不要把「员工端/管理端」当成两个部署环境。

### 3.3 启用站内通知

在「通知中心」为 `dsh-work` 启用 `IN_APP` 渠道。即使 dsh-work 暂时不主动发通知，这也是 AI Hub `API_ONLY` 接入认证的必需项；未启用时认证会返回 `IN_APP notification channel is not enabled`。

### 3.4 登记 dsh-work 权限点

AI Hub 权限编码只允许小写字母、数字、下划线和点，因此不能使用 `workbench:use` 这类冒号编码。在「权限与安全 → 权限点」登记：

| 权限编码 | 建议名称 | 风险 |
| --- | --- | --- |
| `dsh_work.workbench.use` | 使用员工工作台 | LOW |
| `dsh_work.workbench.manage` | 管理部门工作内容 | MEDIUM |
| `dsh_work.admin.read` | 读取管理配置 | MEDIUM |
| `dsh_work.admin.write` | 变更平台配置 | HIGH |
| `dsh_work.audit.read` | 读取安全审计 | HIGH |

### 3.5 创建角色并分配用户

| AI Hub 应用角色 | 权限点 |
| --- | --- |
| 员工 | `dsh_work.workbench.use` |
| 部门负责人 | `dsh_work.workbench.use`、`dsh_work.workbench.manage` |
| 安全审计员 | `dsh_work.admin.read`、`dsh_work.audit.read` |
| 平台管理员 | `dsh_work.admin.read`、`dsh_work.admin.write`、`dsh_work.audit.read`、`dsh_work.workbench.use` |

为用户分配应用角色时同时选择 AI Hub 数据范围。dsh-work 仍会在服务端继续校验工作空间成员关系、Agent/Skill/Tool 版本和业务对象归属，AI Hub 数据范围不会扩大业务系统的最终权限。

## 4. dsh-work 环境变量

复制 [`.env.example`](../../.env.example) 的 SSO 配置，并将下列内容写入本地 `.env`：

```dotenv
DSH_WORK_AUTH_MODE=oidc
DSH_WORK_SERVER_HOST=0.0.0.0
DSH_WORK_DATABASE_URL=postgres://dsh_work:<password>@127.0.0.1:5432/dsh_work

AI_HUB_PLATFORM_URL=http://platform.localhost:8088
AI_HUB_APPLICATION_ID=dsh-work
AI_HUB_OIDC_ISSUER=<AI Hub 凭据弹窗中的 Issuer>
AI_HUB_CLIENT_ID=<AI Hub 凭据弹窗中的 Client ID>
AI_HUB_CLIENT_SECRET=<只展示一次的 Client Secret>

AI_HUB_WORKBENCH_PORTAL_URL=http://localhost:4174
AI_HUB_WORKBENCH_REDIRECT_URI=http://localhost:4190/auth/workbench/callback
AI_HUB_ADMIN_PORTAL_URL=http://localhost:4180
AI_HUB_ADMIN_REDIRECT_URI=http://localhost:4190/auth/admin/callback

DSH_WORK_SESSION_SECRET=<openssl rand -base64 48 的输出>
DSH_WORK_COOKIE_SECURE=false
DSH_WORK_ADMIN_ONLINE_AUTHORIZATION=true
```

`AI_HUB_OIDC_AUDIENCE` 默认等于 `AI_HUB_CLIENT_ID`，只在 AI Hub 明确发放不同 `aud` 时覆盖。如果未来把员工端和管理端拆成两个 AI Hub 应用，可使用 `AI_HUB_WORKBENCH_*` / `AI_HUB_ADMIN_*` 凭据变量覆盖共享值。

生产环境必须使用 HTTPS、`DSH_WORK_COOKIE_SECURE=true`、`DSH_WORK_ADMIN_ONLINE_AUTHORIZATION=true`，且 Session Secret 与 Client Secret 不能是示例占位值。服务端会拒绝关闭在线管理授权校验的生产配置。

生产反向代理还必须在两个前端域名上将 `/api/*` 和 `/auth/*` 转发到 dsh-work server，并保留 `Origin`、`Host`、`X-Forwarded-Proto` 和 `Set-Cookie`。每个 `AI_HUB_*_PORTAL_URL` 必须等于对应前端的外部 Origin，回调 URL 使用同一外部域名的 `/auth/.../callback`，不应向浏览器暴露内部容器地址。

## 5. 启动与验收

1. 确认 PostgreSQL 可用，dsh-work 启动时会自动执行 `0014_m6_ai_hub_sso.sql` 和 `0015_m6_identity_grant_sources.sql`。
2. 启动 AI Hub，然后执行 `pnpm dev:all`。
3. 检查 `curl -fsS http://localhost:4190/health/live`。
4. 打开 `http://localhost:4174/workbench`，应自动跳转 AI Hub 登录并回到原页。
5. 打开 `http://localhost:4180/overview`，用员工账号应显示无权限，用审计员可只读，用平台管理员可写。
6. 停用或收回 AI Hub 权限后，等待授权快照过期或重新登录，确认访问被拒绝。
7. 停止 AI Hub Platform API 后尝试管理写操作，应返回 `503`，不得绕过在线授权。

### 5.1 API_ONLY 接入认证前置清单

在 AI Hub「接入治理」发起 `API_ONLY` 认证前逐项确认：

- 应用包含 `API_CLIENT` 能力，应用与目标环境均为 `ACTIVE`。
- 目标环境存在 `ACTIVE` 凭据，已绑定 Service Subject，并至少登记一个严格 OIDC 回调地址。
- Scope 同时包含 `ai_hub.identity`、`platform.application.read`、`platform.me.read`、`platform.notification.request`；管理写操作另外需要 `platform.authorization.decide`。
- 至少有一个启用的 dsh-work 权限点。
- `IN_APP` 通知渠道已启用。

认证通过后保存运行编号、检查结果和证据；任一项失败时按 AI Hub 返回的 `missing_scopes`、`permission_count`、`notification_enabled` 等证据修正后重新运行。

## 6. 仍需人工完成的事项

代码侧已完成；以下操作涉及 AI Hub 和真实凭据，必须由平台管理员完成：

- 在 AI Hub 注册/启用 `dsh-work` 应用与环境。
- 登记两个严格 OIDC 回调地址。
- 选择必要的 Platform Scope，创建凭据并安全保存一次性 Secret。
- 启用 `IN_APP` 通知渠道。
- 登记 5 个 dsh-work 权限点，创建角色并为试点用户分配授权和数据范围。
- 为 staging/production 分别建立环境、凭据、回调和 Secret，禁止跨环境共用。
- 通过 AI Hub「接入治理」的 `API_ONLY` 认证并保存验收证据。
