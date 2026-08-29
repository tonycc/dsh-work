# dsh-work 持续集成基线

版本：V0.1
状态：本地质量门禁已启用；托管 Provider 待 D-11 确认

## 1. 唯一必跑命令

```bash
pnpm install --frozen-lockfile
pnpm ci:check
```

`pnpm ci:check` 按顺序执行：

1. `pnpm verify:m0`：检查产品、原型、契约、数据和治理基线；
2. `pnpm typecheck`：检查两个 Vue 应用和 Node.js 服务；
3. `pnpm lint`：检查双前端/双 API 架构边界、UI 契约和 ESLint；
4. `pnpm build`：生成员工工作台、管理后台和服务端产物。

任一步失败，流水线必须失败且禁止合并。

## 2. Provider 接入要求

确认 GitHub、GitLab 或企业平台后，流水线必须满足：

- 使用仓库 `packageManager` 指定的 pnpm 版本和兼容 Node.js LTS；
- 使用锁文件安装，不自动修改 `pnpm-lock.yaml`；
- 对合并请求和主分支推送运行 `pnpm ci:check`；
- 主分支禁止绕过必需检查，至少一名非提交者评审；
- 不把模型、SSO、连接器或数据库密钥放入仓库和构建日志；
- 构建产物与源码 Commit、流水线编号建立关联；
- 依赖真实外部服务的测试放在受控集成环境，不降低基础门禁稳定性。

## 3. 后续质量层级

| 阶段 | 新增门禁 |
|---|---|
| M1 | Runtime Adapter 契约、取消、超时和资源隔离测试 |
| M2 | 数据库迁移、租户隔离、权限拒绝和审计测试 |
| M3 | Run 状态机、SSE 断线续传、幂等与刷新恢复测试 |
| M4 | Skill/Tool 权限、提示注入和跨数据范围测试 |
| M5 | 文件安全、成果鉴权、备份与恢复演练 |
| M6 | 关键业务 E2E、并发、故障恢复和安全回归 |

## 4. 当前执行证据

- 2026-08-29：本地 `pnpm ci:check` 首次完整通过；
- 构建存在前端入口包超过 500 kB 的非阻塞警告，记录为性能优化项，不影响 M0 契约与功能基线；
- D-11 未确认前不提交某一 Provider 专属流水线文件，避免形成错误的托管假设。
