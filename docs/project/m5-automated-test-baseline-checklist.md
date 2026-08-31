# M5-01 自动化测试基线验收清单

**状态：** 工程验收通过

**日期：** 2026-08-30

**框架决策：** Vue 使用 Vitest + Vue Test Utils + happy-dom；浏览器 E2E 使用 Playwright Chromium；服务端继续使用 Node Test。

## 测试分层

| 层级 | 自动化入口 | 当前覆盖 |
|---|---|---|
| 前端组件 | `pnpm test:m5:frontend` | TaskComposer 空值/提交中禁用、工作空间上下文、提交清理、键盘快捷键 |
| 前端 Store | `pnpm test:m5:frontend` | Run 创建与 SSE 订阅、自动确认投影、管理角色写权限 |
| 前端 API | `pnpm test:m5:frontend` | 员工/管理结构化错误、下载成功 Blob |
| 后端领域 | `pnpm test:m1`、`pnpm test:m2` | Run 状态机、模型治理、Manifest、Runtime 事件/取消/超时/权限 |
| Repository | PostgreSQL 集成命令 | 迁移、事务、幂等、版本、授权、审计和错误投影 |
| API 契约 | `pnpm test:m5:api` | 双 Audience、Envelope、命名空间隔离、员工安全 Agent DTO、错误契约 |
| E2E 冒烟 | `pnpm test:e2e` | 员工工作台→团队工作空间；管理能力页签→Runtimes |

## 完成定义

- [x] 前端测试框架和 DOM 环境固定在锁文件中。
- [x] 两个 Vue 应用都拥有独立测试入口，测试文件与应用一同类型检查和 Lint。
- [x] 关键 Store 不通过只改本地状态伪造服务端成功。
- [x] API 契约使用真实 HTTP Server 验证状态码、Audience 和错误 DTO。
- [x] 后端领域、PostgreSQL Repository 与 DSH Runtime 既有测试保留并进入统一 Gate。
- [x] Playwright 自动启动 Node、员工端和管理端，失败时保留截图、视频和 Trace。
- [x] GitHub Actions 安装固定锁文件依赖和 Chromium，执行质量、PostgreSQL 集成与 E2E。
- [x] E2E 首轮发现的原型 `/agents` 缺失已修复，并由 API 测试防止回归。

## 本地与 CI 命令

```bash
pnpm verify:m5:test
pnpm test:m5:frontend
pnpm test:m5:api
pnpm test:e2e
pnpm ci:check
```

首次运行 E2E 需要：

```bash
pnpm exec playwright install chromium
```

CI 使用 `pnpm exec playwright install --with-deps chromium`。浏览器二进制不进入仓库。

## 边界

- 当前 E2E 是确定性的工程冒烟，使用原型只读查询验证双前端和 Node API 的浏览器集成；真实 DSH、企业 SSO、企业 Connector 与真实知识源仍由集成环境/UAT 覆盖。
- PostgreSQL 全量测试继续在独立测试库运行；`ci:check` 不隐式创建或删除本地数据库。
- M5-02～M5-04 将继续增加安全、故障和容量测试，不能把本基线等同于完整上线测试通过。

## 结论

M5-01 工程 Gate 关闭。前端组件/Store/API、后端领域/Repository/API、Runtime 契约和浏览器 E2E 已具备可重复入口并进入 GitHub CI。
