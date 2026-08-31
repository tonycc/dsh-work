# dsh-work 持续集成基线

版本：V0.2
状态：GitHub 已确认，仓库工作流已建立；首次托管运行待绑定远程仓库后验证

## 1. 唯一必跑命令

```bash
pnpm install --frozen-lockfile
pnpm ci:check
```

`pnpm ci:check` 按顺序执行：

1. `pnpm verify:m0`：检查产品、原型、契约、数据和治理基线；
2. `pnpm verify:m1` / `verify:m2`：检查 Runtime POC、迁移、Repository、模型治理和退出清单；
3. `pnpm verify:m4:*` / `verify:m5:test` / `verify:m5:security` / `verify:m5:faults` / `verify:m5:capacity`：检查 M4 功能、M5 自动化、安全、故障恢复与容量证据；
4. `pnpm typecheck`：检查两个 Vue 应用和 Node.js 服务；
5. `pnpm test:m1` / `test:m2`：执行 Runtime 与 M2 领域单元测试；
6. `pnpm test:m5:frontend` / `test:m5:api` / `test:m5:security` / `test:m5:faults`：执行前端组件/Store/API、真实 HTTP、安全与 SSE 恢复测试；
7. `pnpm check:secrets`：扫描版本控制候选文件中的已知凭据签名；
8. `pnpm lint`：检查双前端/双 API 架构边界、UI 契约和 ESLint；
9. `pnpm build`：生成员工工作台、管理后台和服务端产物。

GitHub Actions 同一 Job 额外启动 PostgreSQL 17 Service，顺序执行 M2～M4、M5-02 安全、M5-03 故障恢复和 M5-04 容量 PostgreSQL 集成测试；随后安装 Playwright Chromium 并执行 `pnpm test:e2e`。本地没有测试数据库时，`ci:check` 不隐式创建或删除数据库。

任一步失败，流水线必须失败且禁止合并。

## 2. Provider 接入要求

GitHub Actions 工作流位于 `.github/workflows/ci.yml`，必须满足：

- 使用仓库 `packageManager` 指定的 pnpm 版本和兼容 Node.js LTS；
- 使用锁文件安装，不自动修改 `pnpm-lock.yaml`；
- 对合并请求和主分支推送运行 `pnpm ci:check`；
- 远程仓库建立后，将 `M0 quality gate` 设为 `main` 分支必需检查；个人项目不强制非提交者评审；
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
| M5 | 前端组件/Store/API、双 Audience API、浏览器 E2E、文件安全、成果鉴权、备份与恢复演练 |
| M6 | 关键业务 E2E、并发、故障恢复和安全回归 |

## 4. 当前执行证据

- 2026-08-29：本地 `pnpm ci:check` 首次完整通过；
- 构建存在前端入口包超过 500 kB 的非阻塞警告，记录为性能优化项，不影响 M0 契约与功能基线；
- 2026-08-29：项目 Owner 确认使用 GitHub，已加入 `.github/workflows/ci.yml`；
- 2026-08-30：M2 增加 PostgreSQL 17 Service 和 Repository 集成测试；本地临时 PostgreSQL 实测 5/5 通过；
- 2026-08-30：M5-01 增加 Vitest 前端测试、Node HTTP API 契约和 Playwright 双前端冒烟；本地前端 9/9、API 8/8、E2E 2/2 通过；
- 2026-08-30：M5-02 增加跨 Workspace、越权、路径穿越、恶意文件、审计脱敏、DSH 子进程环境和 Tool Allowlist 安全 Gate；独立 PostgreSQL 安全回归 4/4 通过；
- 2026-08-30：M5-03 增加 Worker/模型/Tool/网络故障分类、SSE 游标和服务重启恢复 Gate；Runtime 20/20、SSE 1/1、独立 PostgreSQL 故障回归 2/2 通过；
- 2026-08-30：M5-04 增加 1/3/5 并发和 50 Run 排队容量 Gate；并发 5 时严格运行 5、排队 45，50/50 成功，受理 P95 74.66 ms；
- 首次托管运行必须在远程仓库创建并推送后补充 URL 或运行编号，此项不阻塞 M0 基线冻结。
