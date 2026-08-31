# DSH Runtime 交付基线

更新时间：2026-08-30

## 1. 结论

dsh-work 不复制、Fork 或编译依赖 DSH 内部源码；DSH 作为固定版本的独立 Runtime 制品交付。dsh-work 只维护 Runtime Manifest、ACP Adapter、进程生命周期、安全事件和脱敏观测投影。

本地开发允许使用经过版本和 Commit 校验的 DSH 源码 checkout。integration、staging 和 pilot 必须使用受管制品，不得依赖相邻源码目录或 `tsx` 开发入口。

## 2. 启动模式

### 2.1 本地源码模式

```bash
DSH_RUNTIME_HOME=/Users/max/projects/deepseek-harness
DSH_EXPECTED_VERSION=0.1.1-rc.2
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

未设置 `DSH_RUNTIME_HOME` 时，本地开发回退到 `../deepseek-harness`。服务端读取 `package.json` 并通过 Git 校验当前 HEAD；不匹配时拒绝启动。

### 2.2 受管制品模式

```bash
DSH_RUNTIME_HOME=/opt/dsh/runtime-0.1.1-rc.2
DSH_RUNTIME_COMMAND=/opt/dsh/runtime-0.1.1-rc.2/bin/dsh-acp
DSH_RUNTIME_ARGS_JSON=[]
DSH_EXPECTED_VERSION=0.1.1-rc.2
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

Runtime 根目录必须包含：

```text
runtime-0.1.1-rc.2/
├── bin/dsh-acp
├── dsh-runtime.json
└── config/acp-agent.cordis.yml
```

`dsh-runtime.json` 示例：

```json
{
  "name": "deepseek-harness",
  "version": "0.1.1-rc.2",
  "commit": "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  "protocolVersion": 1,
  "acpConfig": "config/acp-agent.cordis.yml"
}
```

`DSH_RUNTIME_ARGS_JSON` 只包含启动入口所需的额外参数。dsh-work 会在末尾追加受管 `--config` Overlay，挂载 DSH 自己的 Settings 和 Credentials Provider。

## 3. 启动前检查

当 PostgreSQL 主链路启用时，dsh-work 在监听端口前依次检查：

1. Runtime 根目录、启动命令和 ACP 基础配置可访问；
2. Runtime version、Commit 和 ACP 协议版本与 `server/config/dsh/runtime-lock.json` 一致；
3. 启动一个短生命周期 DSH 进程，完成 ACP `initialize` 协商；
4. 关闭预检进程后再开放服务端流量。

任一检查失败均拒绝启动，避免请求进入不兼容 Runtime。预检不创建 Session、不发送 Prompt，也不产生模型调用。

## 4. 凭据边界

- dsh-work 不保存、复制或输出模型密钥正文；
- DSH 通过 `DSH_HOME` 及其 Credentials Provider 解析凭据；
- Runtime Manifest、数据库、Run Event 和应用日志只能出现凭据引用或配置状态；
- `.env.example` 不提供任何密钥字段。

## 5. 升级与回滚

1. 在 DSH 项目构建新 Runtime 制品并生成元数据；
2. 更新 `runtime-lock.json`，运行 M1 Runtime 测试与真实探针；
3. 在 integration 环境完成 ACP、模型、Tool、成果、取消和并发回归；
4. 将 `DSH_RUNTIME_HOME`/`DSH_RUNTIME_COMMAND` 切换到新版本目录；
5. 保留上一个制品目录，失败时恢复两个变量并重启 dsh-work。

DSH 升级不要求迁移 dsh-work 领域数据，也不得绕过 Runtime Adapter 直接依赖 DSH 内部模块。
