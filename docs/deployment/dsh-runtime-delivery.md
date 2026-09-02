# DSH Runtime 交付基线

更新时间：2026-09-02

## 1. 上游事实与当前结论

DeepSeek Harness 上游当前只正式说明两种获取和运行方式：通过 npm 运行已发布的
`@deepseek-ai/dsh`，或者 clone 仓库后从源码构建运行。上游没有名为“受管制品模式”
的部署模式，也不发布本项目旧版文档所描述的 `bin/dsh-acp`、`dsh-runtime.json` 和
`config/acp-agent.cordis.yml` 目录结构。依据见上游固定 Commit 的
[README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/README.zh.md)
和 [CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/apps/cli/README.zh.md)。

`dsh-work` 不复制或 Fork DSH 源码，也不直接依赖 DSH 内部模块。当前经验证且受支持的
运行方式是固定版本和 Commit 的独立源码 checkout，由 Runtime Adapter 通过 ACP
JSON-RPC stdio 启动每个 Attempt 的 Worker。DSH 源码仓库与 `dsh-work` 仓库保持分离。

`dsh-work` 代码中的 `DSH_RUNTIME_COMMAND` 和 `dsh-runtime.json` 解析能力是项目内部
预留的自定义交付契约，不是 DSH 上游功能。目前仓库没有生成该目录结构、可执行文件、
校验和或离线安装包的构建流水线，因此不得把该预留能力描述为已经可用于
integration、staging 或 pilot 的上游受管制品模式，也不得手工建立目录后把源码 clone
到其中冒充制品。

## 2. 当前支持的源码 checkout

### 2.1 安装与构建

当前 Runtime 锁定为：

```text
Version: 0.1.1-rc.2
Commit:  b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
ACP:     protocol version 1
```

Mac mini 推荐将独立 checkout 放在服务账号拥有的源码目录中。本地开发当前使用：

```text
/Users/max/projects/deepseek-harness
```

全新安装步骤：

```bash
cd /Users/max/projects
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
git checkout b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
pnpm install --frozen-lockfile
pnpm run build
```

源码 checkout 不应放入 `dsh-work/node_modules`、`dsh-work/.runtime` 或未来的版本化制品
目录。升级 DSH 时使用新的独立 checkout 或 Git worktree，旧版本保留至回归通过。

### 2.2 dsh-work 配置

```bash
DSH_RUNTIME_HOME=/Users/max/projects/deepseek-harness
DSH_EXPECTED_VERSION=0.1.1-rc.2
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

未设置 `DSH_RUNTIME_HOME` 时，本地开发回退到 `../deepseek-harness`。服务端读取上游
`package.json` 并通过 Git 校验当前 HEAD；版本或 Commit 不匹配时拒绝启动。

固定版本 `0.1.1-rc.2` 的 ACP 入口来自上游 `@deepseek-ai/dsh-acp-demo` 组合，其公开
bin 名称是 `dsh-acp-demo`，不是 `dsh-acp`。当前 Adapter 的源码模式直接启动该组合的
源码入口并应用 `--config` Overlay。依据见上游固定 Commit 的
[ACP package manifest](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/examples/acp-demo/package.json)。

## 3. npm 发行与内部制品的后续方案

上游发布了构建后的 npm 包；这属于官方发行渠道，但不等同于 DSH 自带的“受管制品
模式”。生产交付可以在后续选择“项目本地、精确版本、带 lockfile 和完整性校验的 npm
安装”作为内部 Runtime 制品来源，但不能在服务启动时依赖未固定版本的 `npx` 临时下载。

正式启用 npm 或自定义离线制品前，必须完成：

1. 明确使用固定 `0.1.1-rc.2` 的 `dsh-acp-demo --config`，还是升级到提供
   `dsh --profile acp` 的后续 DSH 版本；
2. 调整 Runtime Adapter 的入口参数和 Overlay 方式，并固定所有 npm 依赖及完整性；
3. 建立可重复构建、校验和、安装、升级、回滚和 SBOM 流程；
4. 在干净的 Mac mini 服务账号环境中完成无源码、无 `tsx` 的 ACP 启动验证；
5. 完成模型、Tool、成果、取消、并发、重启恢复和凭据边界回归。

在以上事项完成前，`DSH_RUNTIME_COMMAND` 保持未设置；integration、staging 和 pilot
的正式交付方式仍是阻塞项，不能宣称已有可部署的受管 Runtime 制品。

## 4. 启动前检查

当 PostgreSQL 主链路启用时，`dsh-work` 在监听端口前依次检查：

1. Runtime 根目录和 ACP 基础配置可访问；
2. 源码模式的 version、Git Commit 和 ACP 协议版本与
   `server/config/dsh/runtime-lock.json` 一致；
3. 启动一个短生命周期 DSH 进程，完成 ACP `initialize` 协商；
4. 关闭预检进程后再开放服务端流量。

任一检查失败均拒绝启动，避免请求进入不兼容 Runtime。预检不创建 Session、不发送
Prompt，也不产生模型调用。

代码仍能在显式设置 `DSH_RUNTIME_COMMAND` 时读取项目自定义的 `dsh-runtime.json`，但
这只是为未来内部制品保留的兼容分支，不构成上游支持或当前生产就绪证明。

## 5. 凭据与数据目录边界

- `dsh-work` 不保存、复制或输出模型密钥正文；
- DSH 通过独立的 `DSH_HOME` 及其 Credentials Provider 解析凭据；
- `DSH_HOME` 是配置和运行数据目录，不是 DSH 源码或安装目录；
- Runtime Manifest、数据库、Run Event 和应用日志只能出现凭据引用或配置状态；
- `.env.example` 不提供任何密钥字段。

## 6. 升级与回滚

当前源码模式按以下流程升级：

1. 在新的独立 checkout 中检出目标 DSH Commit，安装依赖并构建；
2. 更新 `runtime-lock.json`，运行 M1 Runtime 测试与真实探针；
3. 完成 ACP、模型、Tool、成果、取消和并发回归；
4. 将 `DSH_RUNTIME_HOME` 切换到新 checkout 并重启 `dsh-work`；
5. 保留上一个 checkout，失败时恢复 `DSH_RUNTIME_HOME` 并重启。

DSH 升级不要求迁移 `dsh-work` 领域数据，也不得绕过 Runtime Adapter 直接依赖 DSH
内部模块。完成第 3 节的生产制品方案后，再补充对应的制品安装和回滚步骤。
