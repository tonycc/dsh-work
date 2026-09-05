# Mac mini 多 IP 与固定域名实施方案

状态：代码实施完成，待发布和 Mac mini 验收  
更新时间：2026-09-05  
适用范围：`dsh-work`、AI Hub、单台 Apple Silicon Mac mini、Docker Desktop、`launchd`

本文同时记录实施计划与当前进度，不代表相关能力已经发布或部署。执行前必须重新确认两个
仓库的目标 Release、Mac mini 当前运行版本、活动配置、证书、网卡地址和备份状态。

两个项目现已落地多 Origin、OIDC 登录事务入口锁定、未知 Host 拒绝、多 IP Compose
Override、多 SAN 证书及 `plan/check/apply/rollback` 地址管理命令。AI Hub 还会在每次部署时
把 Portal Provider 的严格回调地址对账到完整目标列表。代码和部署契约测试已经通过；正式
Release、第二个 IP 的网卡/路由验收、企业域名、证书签发和 Mac mini 实机验收仍未完成，现网配置不得使用
尚未登记到证书和 OIDC Provider 的入口。

## 1. 目标与已确认决策

### 1.1 目标

在不引入 Kubernetes、微服务或额外常驻运维控制面的前提下，实现：

1. Mac mini 的两个或更多已配置内网 IP 都可访问 AI Hub 和 `dsh-work`；
2. 固定企业内网域名可访问同一组应用；
3. 直接 IP 与固定域名都是长期受支持入口，不把 IP 降级为临时或应急入口；
4. 增加、停用或更换监听 IP 时，由受控部署脚本完成校验、应用和回滚；
5. 域名保持不变时，仅修改域名解析到的 IP 不需要更换证书；
6. 两个项目继续独立构建、发布、部署和回滚；
7. 普通 GitHub push 只执行 CI，Release 可自动发布，Mac mini 端仍由操作员人工批准部署。

### 1.2 关键决策

- **入口并列**：所有配置在允许列表中的 IP 和域名均可打开、登录并使用应用，不做 IP 到域名的强制跳转。
- **Issuer 唯一但不强制使用域名**：OIDC 每个 Provider 仍只有一个固定 Issuer；Issuer
  可以使用 IP 或域名。本方案选择固定认证域名，是为了让监听 IP 增加或更换时不改变 Token
  的 `iss` 和客户端配置；入口并列不等于一个 Provider 可以拥有多个 Issuer。
- **会话隔离**：IP-A、IP-B 和域名是不同浏览器 Origin，Cookie 不共享，用户切换入口时允许重新登录。
- **证书按项目隔离**：AI Hub 与 `dsh-work` 分别持有自己的服务器证书和私钥，但可以由同一企业内部 CA 签发。
- **明确绑定**：只绑定允许的网卡 IP，不用 `0.0.0.0` 代替多地址配置。
- **无可写网络后台**：业务后台不直接修改 macOS 网卡、Docker Socket、`runtime.env`、证书或企业 DNS。
- **脚本为配置入口**：两个项目提供相同语义的 `plan/check/apply/rollback` 地址管理脚本。
- **保留现有端口**：AI Hub 平台 `443`、认证 `8443`、员工端 `4174`、管理端 `4180`。统一无端口 `443` 不在本期范围内。

### 1.3 不在本期范围

- 自动配置 macOS 网卡地址、DHCP Reservation、VLAN 或静态路由；
- 自动修改企业 DNS；
- 把离线 CA 私钥放到 Mac mini 或 Web 后台；
- 多台 Mac mini 的负载均衡、共享 Session、高可用数据库或故障漂移；
- 所有应用共用一个 `443` 入口的共享反向代理；
- DNS 完全不可用时仍通过裸 IP 完成新的 OIDC 登录。

最后一项是协议边界：应用可以从 IP 入口发起登录，但会跳转到固定认证域名。若要求 DNS
不可用时也能新登录，需要为每个 IP 建立独立 OIDC Provider/Issuer 和客户端配置，复杂度、
密钥数量与测试范围都会显著增加，应另立项目评审。

## 2. 当前基线与差距

### 2.1 dsh-work

当前生产配置只有：

- 一个 `DSH_WORK_BIND_ADDRESS`；
- 一个 `DSH_WORK_PUBLIC_HOST`；
- 员工端、管理端各一个 Portal URL 和 Redirect URI；
- 一个证书文件，预检只检查一个 IP SAN；
- Compose 为每个 HTTPS 端口只生成一条宿主机端口映射；
- CSRF 来源校验只接受一个 Portal Origin；
- OIDC 登录和换码始终使用固定 Redirect URI。

主要改造文件：

- `deploy/runtime.env.example`
- `deploy/compose.yaml`
- `deploy/nginx/default.conf.template`
- `deploy/nginx/proxy_params`
- `scripts/deploy/preflight.sh`
- `scripts/deploy/release.sh`
- `scripts/deploy/issue-intranet-ip-certificate.sh`
- `server/src/modules/identity/config.ts`
- `server/src/modules/identity/types.ts`
- `server/src/modules/identity/auth-service.ts`
- `server/src/modules/identity/session-repository.ts`
- `server/migrations/`

### 2.2 AI Hub

当前 Mac mini IP-only Profile 只有：

- 一个 `AI_HUB_SERVER_IP`；
- 由该 IP 派生的平台、认证、门户和 OIDC 地址；
- Traefik 每个 HTTPS 端口只生成一条宿主机端口映射；
- AI Hub Portal 只有一个 OIDC Redirect URI 和 Logout Redirect URI；
- Portal 登录事务不保存本次登录使用的 Redirect URI；
- 证书签发和部署预检只接受一个 IP SAN；
- Authentik Blueprint 中 AI Hub Portal Provider 只有一个回调地址。

主要改造文件：

- `deploy/compose.intranet-ip.yaml`
- `deploy/traefik/dynamic.intranet-ip.yaml`
- `deploy/authentik/ai-hub-blueprint.yaml`
- `scripts/deploy/generate-macmini-runtime-env.sh`
- `scripts/deploy/set-macmini-ip.sh`
- `scripts/deploy/macmini-image-deploy.sh`
- `scripts/deploy/issue-intranet-ip-certificate.sh`
- `scripts/deploy/reconcile-authentik-blueprints.py`
- `backend/src/ai_hub_platform/config.py`
- `backend/src/ai_hub_platform/api/portal_auth.py`
- `backend/src/ai_hub_platform/modules/portal/service.py`
- `backend/migrations/versions/core/`

AI Hub 的应用环境已经支持登记多个 `oidc_redirect_uris`，`dsh-work/production` 可以复用该
能力登记多个员工端和管理端回调；仍需改造的是 AI Hub 自己的 Portal 登录流程与内置 Provider。

## 3. 目标部署架构

以下用当前地址说明。`IP_B` 已确定为 `192.168.101.20`；企业域名稍后在 Mac mini 和企业
DNS 侧配置，本次先启用双 IP：

```text
企业网络 A ── IP_A = 192.168.33.20 ─┐
                                      ├─ 单台 Mac mini
企业网络 B ── IP_B = 192.168.101.20 ──┘

企业内部 DNS（推荐 split-horizon）
  aihub.<企业域名>.com ──> 当前网络可路由的 Mac mini IP
  auth.<企业域名>.com  ──> 当前网络可路由的 Mac mini IP
  work.<企业域名>.com  ──> 当前网络可路由的 Mac mini IP

Mac mini
  Docker Desktop
    AI Hub Traefik
      IP_A/IP_B:443  -> AI Hub Portal + API
      IP_A/IP_B:8443 -> Authentik
    dsh-work Nginx
      IP_A/IP_B:4174 -> 员工端
      IP_A/IP_B:4180 -> 管理端
    PostgreSQL 仍只发布到 127.0.0.1
  launchd
    dsh-work Node 仍只监听 127.0.0.1:4190
    两个项目原有 Release watcher 保持原职责
```

### 3.1 推荐访问矩阵

| 能力 | IP 入口 | 域名入口 | 默认生成链接 |
| --- | --- | --- | --- |
| AI Hub 平台 | `https://IP_A/`、`https://IP_B/` | `https://aihub.<企业域名>.com/` | 平台域名 |
| AI Hub 认证页面 | `https://IP_A:8443/`、`https://IP_B:8443/` | `https://auth.<企业域名>.com:8443/` | 认证域名 |
| dsh-work 员工端 | `https://IP_A:4174/`、`https://IP_B:4174/` | `https://work.<企业域名>.com:4174/` | 工作台域名 |
| dsh-work 管理端 | `https://IP_A:4180/`、`https://IP_B:4180/` | `https://work.<企业域名>.com:4180/` | 管理端域名加端口 |

“默认生成链接”只用于 AI Hub 应用入口、登出返回地址和服务端生成的绝对 URL，不降低其他
入口的支持等级。

### 3.2 OIDC 约束

每个 Provider 的 Issuer 固定使用认证域名，例如：

```text
AI Hub Portal:
https://auth.<企业域名>.com:8443/application/o/ai-hub-portal/

dsh-work production:
https://auth.<企业域名>.com:8443/application/o/dsh-work/
```

从 IP 或域名入口发起登录时，应用根据已验证的当前 Origin 选择相同 Origin 下的回调地址，
然后跳转到上述固定 Issuer。换码时必须使用登录事务中保存的同一个 Redirect URI。

## 4. 配置契约

### 4.1 表达格式

为保持 `runtime.env` 的可读性和 shell 兼容性，多值使用无空格的逗号分隔格式：

```dotenv
KEY=value1,value2,value3
```

解析器必须：

- 去除每项首尾空白；
- 拒绝空项、重复项、换行、控制字符和 UserInfo；
- IP 仅接受实际分配给 Mac mini 的 RFC1918 IPv4；
- 生产 Origin 仅接受 `https`，不接受路径、Query 或 Fragment；
- 对 Origin 做协议、主机、显式端口归一化后再比较；
- 保留输入顺序，第一项仅作为默认值，不代表唯一入口。

### 4.2 dsh-work 新配置

```dotenv
DSH_WORK_BIND_ADDRESSES=192.168.33.20,192.168.101.20

DSH_WORK_WORKBENCH_ORIGINS=https://192.168.33.20:4174,https://192.168.101.20:4174,https://work.<企业域名>.com:4174
DSH_WORK_ADMIN_ORIGINS=https://192.168.33.20:4180,https://192.168.101.20:4180,https://work.<企业域名>.com:4180

DSH_WORK_WORKBENCH_DEFAULT_ORIGIN=https://work.<企业域名>.com:4174
DSH_WORK_ADMIN_DEFAULT_ORIGIN=https://work.<企业域名>.com:4180

AI_HUB_PLATFORM_URL=https://aihub.<企业域名>.com
AI_HUB_OIDC_ISSUER=https://auth.<企业域名>.com:8443/application/o/dsh-work/
```

回调地址由允许的 Origin 和固定路径派生：

```text
<员工端 Origin>/auth/workbench/callback
<管理端 Origin>/auth/admin/callback
```

兼容规则：

- 未配置新变量时，把原有 `DSH_WORK_BIND_ADDRESS`、`AI_HUB_*_PORTAL_URL` 和
  `AI_HUB_*_REDIRECT_URI` 解析为单元素列表；
- 新旧变量同时存在且含义不一致时启动失败，不静默选择；
- 兼容期至少跨一个稳定 Release；移除旧变量必须另发破坏性变更公告。

### 4.3 AI Hub 新配置

```dotenv
AI_HUB_BIND_ADDRESSES=192.168.33.20,192.168.101.20

AI_HUB_PLATFORM_ORIGINS=https://192.168.33.20,https://192.168.101.20,https://aihub.<企业域名>.com
AI_HUB_PLATFORM_DEFAULT_ORIGIN=https://aihub.<企业域名>.com

AI_HUB_IDENTITY_ORIGINS=https://192.168.33.20:8443,https://192.168.101.20:8443,https://auth.<企业域名>.com:8443
AI_HUB_IDENTITY_DEFAULT_ORIGIN=https://auth.<企业域名>.com:8443

AI_HUB_PORTAL_OIDC_REDIRECT_URIS=https://192.168.33.20/auth/callback,https://192.168.101.20/auth/callback,https://aihub.<企业域名>.com/auth/callback
AI_HUB_PORTAL_OIDC_LOGOUT_REDIRECT_URIS=https://192.168.33.20/,https://192.168.101.20/,https://aihub.<企业域名>.com/
```

以下单值继续存在，但改为引用默认域名，而不是监听 IP：

```dotenv
AI_HUB_OIDC_ISSUER=https://auth.<企业域名>.com:8443/application/o/ai-hub/
AI_HUB_PORTAL_OIDC_ISSUER=https://auth.<企业域名>.com:8443/application/o/ai-hub-portal/
AI_HUB_AUTHENTIK_EXTERNAL_URL=https://auth.<企业域名>.com:8443
AI_HUB_PUBLIC_PLATFORM_BASE_URL=https://aihub.<企业域名>.com
AI_HUB_PUBLIC_IDENTITY_BASE_URL=https://auth.<企业域名>.com:8443
AI_HUB_PORTAL_EXTERNAL_URL=https://aihub.<企业域名>.com
```

兼容规则与 `dsh-work` 相同：旧 `AI_HUB_SERVER_IP` 自动形成单元素监听列表；新旧配置冲突
时预检失败。不得重新运行首次配置生成器覆盖已有 `runtime.env`，所有现有 Secret 必须原样
保留。

## 5. dsh-work 实施任务

### 5.1 配置与类型

1. 把 `OidcAudienceConfiguration.portalUrl`、`redirectUri` 扩展为：
   - `allowedOrigins`；
   - `defaultOrigin`；
   - `redirectUriByOrigin`；
2. 增加严格的 Origin 列表解析和重复检测；
3. 验证员工端 Origin 只能使用员工端端口，管理端 Origin 只能使用管理端端口；
4. 验证每个派生回调地址没有 Query、Fragment 或凭据；
5. 保留单值环境变量兼容入口。

### 5.2 OIDC 登录事务

登录时：

1. 从 Nginx 转发的协议和 Host 计算请求 Origin；
2. 仅在该 Origin 位于对应允许列表时继续；
3. 选择该 Origin 对应的 Redirect URI；
4. 将 `portal_origin` 和 `redirect_uri` 与 state、PKCE verifier 一同存入登录事务；
5. 回调换码必须使用事务中保存的 Redirect URI；
6. `return_to` 只能落在同一个事务 Origin，禁止跨 Origin 开放重定向。

数据库迁移采用 expand-only：

- 给 `oidc_login_transactions` 增加可空的 `portal_origin`、`redirect_uri`；
- 新代码读取旧记录时回退到单值配置；
- 本次 Release 不删除旧列或旧配置兼容代码。

### 5.3 Host、Origin 与代理

- Nginx 为允许的 IP 和域名生成明确 `server_name`；
- 增加 default server，对未知 Host 返回 `421` 或直接关闭连接；
- `proxy_params` 明确转发 `X-Forwarded-Proto`、`X-Forwarded-Host` 和原始端口；
- Node 只信任来自本机 Nginx 的转发头，并再次校验允许列表；
- 所有非安全方法继续要求精确 Origin；
- 不能使用请求提供的 Host 直接拼接 OIDC 回调或登出 URL。

### 5.4 Compose 多 IP 映射

新增 `scripts/deploy/render-endpoint-compose.sh`，根据已验证地址生成：

```text
<部署根>/generated/compose.endpoints.yaml
```

生成文件只包含端口映射和必要的只读代理配置挂载，不包含 Secret。所有 Compose 调用统一
追加该文件。生成过程必须使用临时文件、语法校验和原子替换。

### 5.5 部署命令

新增统一入口：

```bash
bash current/scripts/deploy/set-macmini-endpoints.sh plan  ...
bash current/scripts/deploy/set-macmini-endpoints.sh check ...
bash current/scripts/deploy/set-macmini-endpoints.sh apply ... --confirm
bash current/scripts/deploy/set-macmini-endpoints.sh rollback ... --confirm
```

`apply` 只修改地址相关字段，不能重写数据库密码、Session Secret、DSH 路径或 GitHub 配置。
执行 `check/apply` 前，必须先把同时覆盖旧入口和新入口的扩展 SAN 证书安装到既有证书路径；
这样回滚地址配置时仍可沿用该证书，不需要回滚私钥。
仅地址变化时不执行同版本 `release.sh`，而是：

1. 完成全部候选配置预检；
2. 原子安装候选证书和生成的 Compose Override；
3. 重启 `launchd` Node 进程以加载 Origin/OIDC 配置；
4. `--force-recreate` 重建 Nginx；
5. 检查全部员工端和管理端入口；
6. 失败时恢复旧环境文件、证书和 Override，再恢复旧进程。

## 6. AI Hub 实施任务

### 6.1 Settings 与 Portal 登录

1. 在 Pydantic Settings 中增加监听地址、平台 Origin、认证 Origin 和回调列表；
2. 保留现有单值字段作为默认/兼容字段；
3. Portal `/auth/login` 根据已验证请求 Origin 选择回调地址；
4. `portal_login_transaction` 增加 `portal_origin`、`redirect_uri`；
5. `/auth/callback` 使用事务中的 Redirect URI 换码；
6. 登录成功只重定向到同一事务 Origin 下的安全路径；
7. Logout 使用与当前 Portal Origin 对应的已登记返回地址。

迁移同样必须 expand-only，确保旧镜像读取新 Schema 时仍可运行，满足现有回滚门禁。

### 6.2 Authentik Redirect URI 对账

AI Hub 自己的 Portal Provider 需要多个严格回调。由于 Blueprint 的单个 `!Env` 不能可靠
表达动态长度列表，新增受信任 Worker 内的固定用途对账脚本：

1. Blueprint 继续定义 Provider、Scope 和基础安全属性；
2. Blueprint 应用成功后，在 `authentik-worker` 内运行受控 `ak shell`；
3. 只修改已知 Provider 的 `redirect_uris` 字段；
4. 目标列表来自已经过部署脚本验证的环境变量；
5. 每次按完整目标列表收敛，删除不再允许的旧地址；
6. 写入后重新查询并逐项比较，失败则部署不记为成功。

`dsh-work/production` 的多个回调继续通过 AI Hub 应用环境管理能力登记，每行一个，不需要为
每个 IP 创建独立应用或独立 Client Secret。

### 6.3 Traefik 与 Compose

- 新增 AI Hub 端点 Compose 渲染脚本，生成每个 IP 的 `443`、`8443` 映射；
- Traefik Router 增加明确的 Host 允许规则或等价白名单中间件；
- 未知 Host 必须拒绝，不能继续使用无条件 `PathPrefix` 暴露全部入口；
- 平台 API、Portal、Authentik、PostgreSQL 和内部服务网络边界保持不变；
- 证书文件路径保持稳定，更新证书只强制重建无状态 Traefik。

### 6.4 部署脚本

用 `set-macmini-endpoints.sh` 替代仅能修改一个 IP 的 `set-macmini-ip.sh`；旧脚本只保留给
尚未启用多入口变量的单 IP 配置使用。多入口配置继续调用旧脚本会因新旧字段冲突而安全
失败，不会静默丢失其他入口。

当前实现要求在 `check/apply` 前，先把覆盖全部候选 IP/域名的证书安装到 `runtime.env`
已有证书路径。地址命令不会接收离线 CA 私钥，也不会在服务器上签发证书。

`macmini-image-deploy.sh` 必须：

- 校验每个绑定 IP 都已分配到 Mac 网卡；
- 校验每个 IP/域名均被证书 SAN 覆盖；
- 加载生成的 Endpoint Compose Override；
- 在应用 Blueprint 后对账所有回调；
- 对每个平台入口和认证入口执行 readiness；
- 地址变化但镜像/Schema 不变时，不误判为镜像升级或要求无关迁移；
- 地址应用失败时恢复旧地址配置和 Traefik。

## 7. 证书实施方案

### 7.1 证书划分

AI Hub 证书建议包含：

```text
IP:192.168.33.20
IP:192.168.101.20
DNS:aihub.<企业域名>.com
DNS:auth.<企业域名>.com
```

`dsh-work` 证书建议包含：

```text
IP:192.168.33.20
IP:192.168.101.20
DNS:work.<企业域名>.com
```

### 7.2 签发脚本

两个项目的 `issue-intranet-ip-certificate.sh` 升级为兼容入口，并新增通用命令：

```bash
bash scripts/deploy/issue-intranet-certificate.sh \
  --ca-dir /absolute/offline/ca \
  --ip 192.168.33.20 \
  --ip 192.168.101.20 \
  --dns aihub.<企业域名>.com \
  --dns auth.<企业域名>.com \
  --output-dir /absolute/staging/ai-hub
```

要求：

- `--ip`、`--dns` 可重复；
- 至少有一个 SAN；
- IP 只接受 RFC1918 地址；
- DNS 名称必须小写、无通配符、无尾部点并通过标签长度校验；
- 输出证书后逐个执行 `openssl x509 -checkip/-checkhost`；
- 根 CA 私钥始终留在离线运维工作站；
- Mac mini 只接收 `server.crt`、`server.key`、`root-ca.crt`；
- 两个项目私钥不同、文件权限 `0600`。

### 7.3 更换地址时的证书规则

| 变化 | 是否重签服务器证书 |
| --- | --- |
| 域名不变，只修改 DNS 指向的 IP | 否 |
| 新增一个需要直接 HTTPS 访问的 IP | 是，除非该 IP 已在 SAN 中 |
| 删除一个 IP | 不要求立即重签，但下一次续期应移除 |
| 新增域名 | 是，除非域名已在 SAN 中 |
| 证书到期或私钥泄露 | 是 |

## 8. DNS 与网络方案

### 8.1 企业 DNS

双网卡连接不同网络时优先使用 split-horizon DNS：

- 网络 A 的 DNS View 返回 IP-A；
- 网络 B 的 DNS View 返回 IP-B；
- 不向客户端返回它无法路由的地址；
- 域名、证书和 OIDC 配置保持完全相同。

如果所有客户端都能路由两个 IP，可以配置多个 A 记录，但普通 DNS 轮询不提供健康剔除，
任何一个 IP 故障都可能造成间歇性连接失败。

上线前把 TTL 临时调整为 `60-300` 秒；验证稳定后再提高。DNS 变更由企业 DNS 管理员完成，
部署脚本只验证解析结果，不持有 DNS 管理凭据。

### 8.2 Mac mini 网络前置条件

- 两个 IP 必须通过 DHCP Reservation 或静态配置稳定存在；
- 明确两个 IP 对应的网卡和路由；
- 验证从每个企业网络进入后，响应从正确网卡返回；
- 验证 Docker Desktop 容器能够使用企业 DNS 解析认证域名，并能通过 Mac mini 的发布端口
  回连该域名；AI Hub 的 Token 校验和内部任务不能只在宿主机解析成功；
- macOS 防火墙只允许企业网段访问 `443/8443/4174/4180`；
- `4190/5433/5434` 继续只监听回环；
- Docker Desktop 登录后自动启动，Mac mini 禁止自动睡眠。

## 9. 运维配置边界

### 9.1 本期不增加可写 Web 后台

IP 和域名涉及应用启动前的端口绑定、证书和自我访问能力。把唯一修改入口放在应用自己的
Web 后台会形成“配置错误后无法进入后台修复”的循环，也会迫使容器持有宿主机或 Docker
高权限。

因此本期采用：

- AI Hub 脚本只管理 AI Hub 的地址、证书和 Traefik；
- `dsh-work` 脚本只管理 `dsh-work` 的地址、证书和 Nginx；
- 操作员通过 `deploy` 账号和固定命令依次执行；
- 两个项目不互相写入对方的目录；
- 不新增常驻服务或第三个部署项目。

### 9.2 可选只读展示

后续可以增加只读页面：

- AI Hub「平台设置」显示 AI Hub 当前入口、证书有效期和应用环境登记的回调；
- `dsh-work`「运行与运维」显示员工端/管理端入口、证书有效期和入口健康状态。

页面不得返回私钥、Secret、完整 `runtime.env` 或可用于调用宿主机命令的参数。若未来确实
需要图形化变更，AI Hub 平台后台只能创建“待应用计划”，仍由 Mac mini 本地脚本人工确认。

## 10. 安全与失败关闭要求

- 所有生产入口保持 HTTPS，不能因内网环境禁用证书验证；
- 任何未知 Host、Origin、Redirect URI 都失败关闭；
- 禁止通配 Origin、动态 Host 拼接、跳过 OIDC state/nonce/PKCE；
- 证书必须同时通过链、有效期、SAN 和私钥匹配验证；
- 新 IP 未绑定、证书缺 SAN、端口冲突或 DNS 解析异常时，不修改活动配置；
- 每次地址变更写入不含 Secret 的运维审计日志；
- 候选配置、旧配置和证书备份均使用权限 `0600`；
- 地址配置日志只输出脱敏后的地址、证书指纹和状态，不回显 Secret；
- 任何脚本不得接受任意 Compose 文件、任意服务名或任意 Shell 片段；
- 保留部署锁，禁止 Release 部署和地址变更并发执行。

## 11. 实施阶段与依赖

### 阶段 A：契约与兼容层

1. 在两个项目确定新环境变量、Origin 归一化和旧配置兼容规则；
2. 增加配置解析单元测试；
3. 更新示例配置，但不改变当前单 IP 默认行为；
4. 使用已确认的 IP-B；三个企业域名在域名阶段开始前确定。

完成条件：旧 `runtime.env` 在新版本中仍能以单 IP 模式通过预检并启动。

### 阶段 B：AI Hub 能力

1. 多 Origin Portal 登录；
2. 登录事务保存 Redirect URI；
3. Authentik 多回调对账；
4. 多 IP Compose 生成；
5. 多 SAN 证书和预检；
6. 地址 `plan/check/apply/rollback` 脚本；
7. 发布新的不可变 AI Hub Release。

完成条件：AI Hub 在旧单 IP 配置和候选多 IP/域名配置下均通过 CI 与部署契约测试。

### 阶段 C：dsh-work 能力

1. 多 Origin OIDC 登录和 CSRF 校验；
2. 登录事务迁移；
3. Nginx Host 白名单；
4. 多 IP Compose 生成；
5. 多 SAN 证书和预检；
6. 地址 `plan/check/apply/rollback` 脚本；
7. 更新 AI Hub SSO 接入文档和 Mac mini Runbook；
8. 发布新的不可变 `dsh-work` Release。

完成条件：旧单 IP 配置兼容，全部新入口契约测试通过。

### 阶段 D：Mac mini 多 IP 启用

1. 建立新鲜异机备份并验证回执；
2. 为 Mac mini 配置 IP-B，验证路由和防火墙；
3. 在离线 CA 工作站为两个项目分别签发多 SAN 证书；
4. 人工部署 AI Hub 新版本，仍先使用 IP-A 单地址；
5. 人工部署 `dsh-work` 新版本，仍先使用 IP-A 单地址；
6. AI Hub `plan/check/apply` 增加 IP-B；
7. 在 AI Hub `dsh-work/production` 环境登记 IP-B 回调；
8. `dsh-work` `plan/check/apply` 增加 IP-B；
9. 从两个企业网络分别完成健康、登录、登出、管理写操作和目录同步验收。

完成条件：IP-A、IP-B 均可完成全流程，切换入口需要重新登录但不出现 Token、CSRF 或
Redirect URI 错误。

### 阶段 E：固定域名启用

1. 企业 DNS 创建三个内部 A 记录；
2. 从两个网络验证 split-horizon 解析；
3. AI Hub 增加平台域名、认证域名和 Portal 回调；
4. Authentik 对账新的回调与固定 External URL/Issuer；
5. `dsh-work/production` 增加域名回调；
6. `dsh-work` 增加工作台域名 Origin；
7. 分别应用 AI Hub、`dsh-work` 地址配置；
8. 验证域名入口及所有 IP 入口仍可完整使用；
9. 提高稳定后的 DNS TTL。

完成条件：域名和两个 IP 均为正式入口；修改域名 A 记录指向时不需要重签域名证书。

## 12. 测试计划

### 12.1 配置与安全测试

- 单 IP 旧配置兼容；
- 多 IP、多域名正常解析；
- 空项、重复项、公共 IP、非法端口、HTTP Origin 被拒绝；
- 新旧变量冲突被拒绝；
- 未知 Host 被代理和应用双重拒绝；
- 未知 Origin 的写请求返回 `403`；
- `return_to` 不能跨 Origin；
- 登录回调使用事务保存的 Redirect URI；
- 登录事务只能消费一次且超时失效；
- IP-A、IP-B、域名 Cookie 相互隔离；
- OIDC Token 的 `iss` 始终等于固定 Provider Issuer。

### 12.2 证书与部署测试

- 一个证书包含多个 IP SAN 和 DNS SAN；
- 任意启用入口缺少 SAN 时预检失败；
- IP 未分配到网卡时预检失败；
- 端口占用时不修改活动配置；
- 生成的 Compose Override 包含且只包含预期映射；
- 更新证书后仅重建无状态边缘代理；
- 地址更新不会轮换或回显现有 Secret；
- 应用失败后旧 IP、旧证书和旧配置恢复；
- Release watcher 与地址应用锁互斥。

### 12.3 Mac mini 验收矩阵

对 AI Hub 平台、AI Hub 认证、员工端和管理端逐一验证：

| 验收项 | IP-A | IP-B | 域名 |
| --- | --- | --- | --- |
| TLS 链与 SAN | 必须通过 | 必须通过 | 必须通过 |
| readiness | 必须通过 | 必须通过 | 必须通过 |
| 首次登录 | 必须通过 | 必须通过 | 必须通过 |
| 已登录刷新 | 必须通过 | 必须通过 | 必须通过 |
| 写操作与 CSRF | 必须通过 | 必须通过 | 必须通过 |
| 登出 | 必须通过 | 必须通过 | 必须通过 |
| 审计记录 | 必须产生 | 必须产生 | 必须产生 |

还必须验证：

- 从网络 A 和网络 B 分别访问；
- 从 AI Hub `platform-api`、调度容器以及宿主机 `dsh-work` Node 分别解析固定认证域名并访问
  OIDC Discovery/JWKS；
- AI Hub 暂时不可用时 `dsh-work` 已有 Session 的既有行为没有回归；
- DNS A 记录从 IP-A 切换到 IP-B 后，域名证书无需更换且登录仍成功；
- 直接增加一个不在证书 SAN 中的新 IP 时，部署按预期失败关闭。

## 13. 发布、部署与回滚

### 13.1 发布顺序

1. 合并并发布 AI Hub 兼容版本；
2. 合并并发布 `dsh-work` 兼容版本；
3. GitHub Release 和目标 Mac mini 部署继续作为两个独立状态报告；
4. Mac mini 由操作员先部署 AI Hub，再部署 `dsh-work`；
5. 新能力首次部署仍使用原 IP-A，验证后再应用新增入口。

### 13.2 地址变更回滚

每个项目的地址应用前必须保留：

```text
runtime.env.before-endpoints-<UTC时间>
generated/compose.endpoints.yaml.before-<UTC时间>
certs.before-endpoints-<UTC时间>/
endpoint-change.json
```

回滚顺序：

1. 恢复旧地址字段、证书和生成的 Compose Override；
2. 重建 AI Hub Traefik 或 `dsh-work` Nginx；
3. 重启需要重新读取 OIDC/Origin 配置的应用进程；
4. 验证旧入口健康与登录；
5. 保留失败候选和脱敏日志用于审计，不自动重复应用。

地址回滚不执行数据库降级。新增登录事务字段必须保持旧版本可读，确保应用版本回滚仍安全。

## 14. 最终验收标准

只有同时满足以下条件，才能宣布改造完成：

1. 两个项目的旧单 IP 配置可无损升级；
2. IP-A、IP-B、固定域名均可完成 HTTPS、OIDC 登录、业务写操作和登出；
3. 所有入口使用受信证书，未知 Host/Origin/Redirect URI 被拒绝；
4. 每个项目只维护一张包含其全部 IP/DNS SAN 的服务器证书；
5. 修改固定域名背后的 IP 不需要重签证书；
6. 新增直接访问 IP 时，缺少 IP SAN 会在变更前被拒绝；
7. 地址变更不修改数据库、业务数据、DSH 安装、镜像或 Secret；
8. AI Hub 与 `dsh-work` 可分别发布、分别回滚；
9. Mac mini 没有存放离线 CA 私钥，也没有向 Web 容器暴露 Docker Socket；
10. CI、部署脚本测试、Mac mini 双网络验收和回滚演练全部留有证据。

## 15. 实施前待确认参数

以下参数不影响通用代码开发，但会阻塞正式启用：

| 参数 | 当前状态 |
| --- | --- |
| IP-A | 已确认：`192.168.33.20` |
| IP-B | `192.168.101.20`，待 Mac mini 网卡与双向路由验收 |
| 企业根域名 | 域名阶段开始前确认 |
| AI Hub 平台域名 | 后续在 Mac mini/企业 DNS 配置时确认 |
| AI Hub 认证域名 | 后续在 Mac mini/企业 DNS 配置时确认 |
| dsh-work 域名 | 后续在 Mac mini/企业 DNS 配置时确认 |
| 两个网络的 DNS View 与路由 | 待企业网络管理员确认 |
| 企业 CA 或现有离线 CA 是否继续使用 | 待确认 |
| 域名是否保留现有非标准端口 | 本方案默认保留 |
