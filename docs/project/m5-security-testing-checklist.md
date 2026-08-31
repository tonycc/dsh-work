# M5-02 权限与安全测试验收清单

**状态：** 工程验收通过

**日期：** 2026-08-30

**范围：** 员工 API、管理 API、PostgreSQL Repository、文件存储、DSH Runtime Adapter、审计与 Tool 白名单。

## 自动化覆盖

| 风险面 | 测试与控制 | 结果 |
|---|---|---|
| 越权与跨 Workspace | 非管理员管理写操作失败关闭；非成员不能读取或上传团队文件；拒绝决定写入授权审计 | 通过 |
| 路径穿越 | 上传文件名不参与物理路径；即使数据库被注入 `../` 存储键，读取仍在存储根目录校验处拒绝 | 通过 |
| 恶意文件 | 扩展名、MIME、大小及可执行文件签名在落库前校验；伪装为文本的 MZ 文件被拒绝 | 通过 |
| 日志与审计脱敏 | 管理审计、授权详情、Tool 参数摘要和 Runtime 诊断在持久化/输出前递归脱敏；Token 计数等非凭据指标保留 | 通过 |
| Secret 泄露 | 版本控制候选文件执行已知密钥签名扫描；业务数据库、API 和日志仅保存密钥引用 | 通过 |
| DSH 子进程隔离 | ACP Worker 只继承显式 OS/DSH 基线环境；应用数据库变量和敏感覆盖项不进入子进程 | 通过 |
| Tool Allowlist | Manifest 只注入已授权 Tool；策略插件拒绝未列入 Allowlist 的工具和写入/命令能力 | 通过 |

## 完成定义

- [x] 安全回归使用独立 PostgreSQL 数据库并执行全部迁移。
- [x] 跨用户、跨 Workspace 文件访问与写入均失败关闭。
- [x] 非平台管理员不能执行管理写操作，前端角色不能代替服务端授权。
- [x] 路径穿越和伪装可执行文件不会产生合法文件记录或逃逸存储根目录。
- [x] 审计详情和嵌套 Tool 元数据在写库前脱敏，读取时再次防御性脱敏。
- [x] DSH 子进程环境改为白名单继承，拒绝显式 API Key、密码、Secret、Token 和凭据正文。
- [x] Tool Allowlist 单元测试、Runtime 测试和 PostgreSQL 安全测试进入 CI。
- [x] 仓库 Secret 签名扫描进入 `pnpm ci:check`。

## 执行命令

```bash
pnpm verify:m5:security
pnpm check:secrets
pnpm test:m5:security
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m5:security:integration
pnpm ci:check
```

## 明确边界

- 企业 SSO 尚受 D-03 约束；本次验证的是服务端授权模型和种子身份，不能替代身份提供方签名、生命周期与账号停用测试。
- 当前恶意文件检测是可替换的基础扫描器；企业级恶意文件扫描、隔离、清理和正式存储策略仍由 D-07 及部署环境决定。
- L2 数据字段、脱敏口径和外部模型出口仍受 D-09 约束；本次不宣称真实 ERP/MES 数据出境策略已通过。
- 当前凭据扫描是提交前的签名扫描，不替代企业 Secret Manager、历史提交扫描和凭据轮换；网络出口、防火墙及生产 Secret 后端属于 M5-06。
- 本清单关闭 M5-02 工程 Gate，不等于生产安全评审、渗透测试或试点 Go-Live 已通过。

## 结论

M5-02 工程 Gate 关闭。当前代码基线已对权限隔离、文件边界、日志脱敏、Secret 暴露、DSH 子进程环境和 Tool Allowlist 建立失败关闭控制与可重复自动化证据；外部身份、企业扫描、数据分级和生产网络控制继续作为上线前置条件。
