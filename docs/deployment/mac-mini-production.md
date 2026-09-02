# Mac mini 生产部署

更新时间：2026-09-02

## 1. 部署结论

`dsh-work` 与 AI Hub 可以独立部署、独立升级和独立回滚。两者不共享数据库、Compose
项目或发布版本；`dsh-work` 只通过 AI Hub 的 HTTPS/OIDC/API 地址使用统一身份和员工
目录。因此 AI Hub 可以先部署，`dsh-work` 后部署，也可以分别安排维护窗口。

本方案针对一台 Apple Silicon Mac mini、Docker Desktop、一期内网 IP 访问：

```text
GitHub push
  └─ 自动 CI（只验证，不部署）

GitHub Actions / Manual release
  └─ 人工触发，生成带构建来源证明的不可变 dsh-work-vX.Y.Z Release

Mac mini / launchd Release watcher
  └─ 出站轮询，自动校验 → release.sh → 备份 → 迁移 → 切换 → 健康检查

Mac mini
  ├─ launchd: dsh-work Node 模块化单体
  │    └─ stdio 子进程: 宿主机已安装的固定 DSH
  ├─ launchd: 最小权限 GitHub Public Release 监听器
  └─ Docker Desktop Compose
       ├─ PostgreSQL
       └─ Nginx: 员工端与管理端 HTTPS、API 反向代理
```

后端原生运行不是额外拆分服务。当前 Runtime Adapter 必须把 DSH 作为本机 stdio 子进程
启动；Docker Desktop 的容器运行 Linux，不能直接执行 macOS 宿主机上的 DSH。把 Node
后端交给 `launchd` 是复用既有 DSH 安装、又保持启动恢复简单的最小方案。

公开仓库不在生产 Mac mini 上安装 GitHub Actions Self-hosted Runner。监听器只读取公开
Release 元数据，不能执行 GitHub 下发的任意 Workflow 命令，也不需要开放 SSH、Webhook
或其他入站端口。

## 2. 独立部署边界

| 项目 | 自己持有 | 对另一项目的要求 |
| --- | --- | --- |
| AI Hub | 自己的 Compose、数据库、身份域、镜像和备份 | 无需 dsh-work 在线 |
| dsh-work | 自己的 PostgreSQL、发布包、前端、业务权限、文件和 DSH 数据 | 登录、Token 刷新和目录同步时 AI Hub HTTPS 可达 |

AI Hub 暂时不可用时，已建立且未过期的 dsh-work Session 仍按本地授权工作；新登录、
Token 刷新和员工目录同步会失败关闭。AI Hub 的发布不得重建 dsh-work 数据库，反之亦然。

## 3. Mac mini 前置条件

使用一个专用的普通 macOS 服务账号登录并保持会话：

1. Docker Desktop 已安装，启用登录后启动；
2. Node.js 满足 `22.19+` 或 `24+`，Apple Silicon 默认路径为
   `/opt/homebrew/bin/node`；
3. GitHub CLI 已安装，并用仅限目标仓库的只读凭据登录；凭据只需要读取 Contents 和
   Attestations，不需要写权限；
4. DSH 已在宿主机独立目录安装、安装依赖并构建，版本与
   `server/config/dsh/runtime-lock.json` 完全一致；
5. Mac mini 使用 DHCP Reservation 或静态内网 IP；
6. 系统时间保持自动同步，关闭自动睡眠，并启用断电恢复后的自动启动；OIDC 对时间偏差敏感；
7. 防火墙只向企业内网放行员工端和管理端端口；PostgreSQL 与 Node 端口只监听
   `127.0.0.1`；
8. 内部 CA 证书包含 Mac mini IP 的 SAN，员工设备已信任该 CA。

一期没有企业 CA 时，可以先生成试点 CA 和 IP 证书：

```bash
bash scripts/deploy/generate-ip-certificate.sh 192.168.1.50 /Users/dshdeploy/services/dsh-work
```

必须把生成的 `internal-ca.crt` 安装到所有访问设备的受信任根证书中。企业 CA 可用后，
直接替换 `server.crt`、`server.key` 和 CA 文件，不需要改 Compose。

## 4. 公开仓库发布保护

在 GitHub 仓库中一次性完成以下设置：

1. `Settings → General → Releases → Enable release immutability`；该设置只影响此后新建的
   Release；
2. 保护 `main`，要求 `M6 quality gate` 成功后才能合并；
3. 限制 `.github/workflows/release.yml` 的修改权限和 Manual release 执行权限；
4. 禁止把任何 `runtime.env`、AI Hub Secret、DSH 凭据或证书私钥提交到公开仓库。

发布工作流会使用 GitHub Sigstore 为压缩包生成构建来源证明。Mac mini 同时验证：

- Release 已启用不可变保护，Tag 与资产发布后不能替换；
- Release 由 `github-actions[bot]` 发布并指向 40 位 Commit SHA；
- 压缩包来自本仓库 `.github/workflows/release.yml@main`；
- 构建发生在 GitHub 托管 Runner，而不是 Self-hosted Runner；
- Release 资产、SHA-256、发布包版本和 `release.json` Commit 完全一致。

发布包由明确的文件白名单组装，不会递归复制本机 `deploy/runtime.env`、证书目录或其他
Git 忽略文件；构建目录中出现这些敏感路径时会直接失败。

任何一项失败都会拒绝部署。GitHub 官方说明见
[不可变 Release](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
和[构建来源证明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。

## 5. 首次安装

建议把控制仓库和稳定数据都放在 Docker Desktop 默认允许共享的 `/Users` 下：

```bash
mkdir -p /Users/dshdeploy/services
cd /Users/dshdeploy/services
git clone https://github.com/tonycc/dsh-work.git
cd dsh-work
cp deploy/runtime.env.example runtime.env
chmod 600 runtime.env
```

编辑 `runtime.env`，至少替换以下内容：

- `DSH_WORK_GITHUB_REPOSITORY` 和所有 `/Users/dshdeploy/...` 路径；
- `PATH` 中保留 Homebrew、Docker Desktop 和 macOS 系统命令目录；`launchd` 不会继承交互式
  Shell 的工具路径；
- Mac mini 内网 IP、证书路径和对外端口；
- PostgreSQL 密码与其 URL 编码后的 `DSH_WORK_DATABASE_URL`；
- `DSH_WORK_SESSION_SECRET`；
- AI Hub Platform URL、Issuer、Client ID、Client Secret、Audience；
- AI Hub 中逐字登记的两个 HTTPS 回调地址；
- 已安装 DSH 的绝对路径、锁定 Version 和 Commit。
- `DSH_WORK_AUTO_DEPLOY_ENABLED=true`，轮询间隔保持至少 300 秒。

`runtime.env` 是受信任的 shell-compatible dotenv 文件，会由部署脚本和 `launchd`
加载。含空格或 shell 特殊字符的值必须使用单引号；不要在该文件中写命令。文件权限必须
保持 `600`。

证书、AI Hub 回调和 DSH 路径全部准备好后，安装一次 Release 监听器：

```bash
bash scripts/deploy/install-release-watcher.sh /Users/dshdeploy/services/dsh-work
```

该命令会创建一个专用 `launchd` LaunchAgent 并立即检查最新 Release。此后不需要为每次
发布登录 Mac mini。公开 GitHub API 未认证请求的额度是每个来源 IP 每小时 60 次，默认
300 秒轮询为每小时 12 次；实际 Release 下载和来源证明验证使用 GitHub CLI 的只读凭据。

## 6. 手工批准、自动部署

普通 push 到 `main` 只运行 [CI](../../.github/workflows/ci.yml)，不会生成 Release，也不会
访问 Mac mini。

准备发布时：

1. 确认目标 Commit 的 `M6 quality gate` 成功；
2. 在 GitHub Actions 打开 `Manual release`；
3. 点击 `Run workflow`，选择 `main`，输入与 `server/package.json` 一致的版本，例如
   `0.1.0`；
4. 工作流再次确认目标 Commit 的 CI 结论，构建前后端发布包，生成 SHA-256 和 Sigstore
   来源证明，把资产上传到 Draft Release，最后发布为不可变的 `v0.1.0`；
5. Mac mini 监听器在下一次轮询时自动发现、验证并部署，无需人工执行 `release.sh`。

监听器调用的 `release.sh` 会：

1. 验证不可变 Release、Release 资产、Sigstore 构建来源和 SHA-256，并从已验证归档重新
   建立非活动 Release 目录；
2. 校验 macOS/ARM64、Docker Desktop、Node、证书、AI Hub 生产配置、发布包的 DSH
   Lock，并与宿主机已安装的 DSH 做一次真实 ACP 启动握手；
3. 已有版本时先停止旧后端，并使用旧版本 Compose 生成数据库与持久文件备份；首次部署
   则直接初始化 PostgreSQL；
4. 备份成功后才应用候选版本的 PostgreSQL Compose 配置；
5. 执行向前数据库迁移；
6. 原子切换 `current`，安装/重启 `launchd`，重建 Nginx 容器；
7. 从内网 HTTPS 地址执行健康检查；失败时恢复旧应用版本与旧 PostgreSQL Compose 配置。

数据库迁移不会自动降级。因此每次迁移必须保持至少一个版本的向后兼容，确认新版本稳定
后再进行破坏性清理。

自动部署只接受严格的稳定版本 `vMAJOR.MINOR.PATCH`，且只允许升级，不会自动降级。
部署失败的 Tag 会写入 `automation/state/blocked-release`，不会反复重试和制造重复停机；
发布修复版本是首选处理方式。

## 7. 运行维护

查看状态和日志：

```bash
launchctl print gui/$(id -u)/com.company.dsh-work.server
launchctl print gui/$(id -u)/com.company.dsh-work.release-watcher
tail -f /Users/dshdeploy/services/dsh-work/logs/server.stderr.log
tail -f /Users/dshdeploy/services/dsh-work/logs/release-watcher.stderr.log
docker compose --env-file runtime.env -f current/deploy/compose.yaml ps
docker compose --env-file runtime.env -f current/deploy/compose.yaml logs -f postgres web
```

手工备份会短暂停止并恢复 `launchd` 后端，以保证数据库与持久文件处于一致的维护窗口：

```bash
bash current/scripts/deploy/backup.sh /Users/dshdeploy/services/dsh-work
```

回滚到已下载的旧版本：

```bash
bash current/scripts/deploy/rollback.sh 0.1.0 /Users/dshdeploy/services/dsh-work
```

回滚脚本会自动阻止监听器再次部署被回滚的版本。确认问题解决、确实需要重试同一 Tag 时，
把阻止记录改名保留，再立即触发一次检查：

```bash
mv automation/state/blocked-release automation/state/blocked-release.cleared
launchctl kickstart -k gui/$(id -u)/com.company.dsh-work.release-watcher
```

临时暂停自动部署时，把 `runtime.env` 中的 `DSH_WORK_AUTO_DEPLOY_ENABLED` 改为 `false`；
恢复为 `true` 后执行上面的 `launchctl kickstart`。人工应急部署仍可直接执行已验证版本中的
`current/scripts/deploy/release.sh`。

恢复备份是破坏性操作，脚本要求显式确认，并把原数据目录改名保留：

```bash
bash current/scripts/deploy/restore.sh \
  /Users/dshdeploy/services/dsh-work \
  /Users/dshdeploy/services/dsh-work/backups/20260902T120000Z \
  --confirm
```

如果数据库删除开始后 `pg_restore`、文件解压或服务重建失败，脚本会保持后端和 Nginx
停止，避免空库或半恢复数据对外可见。修复磁盘、备份或数据库问题后，使用同一备份重新
执行恢复命令；不要在恢复未完成时手工启动服务。

备份完成后应复制到另一台设备、NAS 或企业备份系统；同一台 Mac mini 上的备份不能覆盖
整机损坏、失窃或磁盘故障。

## 8. DSH 生命周期

DSH 不随 dsh-work Release 自动升级。每次发布前置检查都会验证 DSH 的 Version、Git
Commit、依赖、构建输出和 tracked file 清洁状态；不匹配就拒绝发布。DSH 升级应单独执行
其安装、构建和 ACP 回归，再更新 dsh-work 的 Runtime Lock。

本方案把已安装 DSH 作为受控的宿主机前置条件，但不等价于已经建立 DSH 内部离线制品
流水线。若后续要求完全离线、SBOM 或统一制品签名，应另行建设 DSH 的固定 npm/离线包。
