# M4-03 预置 Tool/Connector 退出检查

**验证日期：** 2026-08-30

**工程结论：** M4-03 工程范围已完成，可继续实施 M4-04 企业知识查询。该结论不代表企业 ERP/MES Connector 已接通，也不代表 M4 总 Gate 已关闭。

| 验收项 | 结论 | 验收证据 |
|---|---|---|
| 预置能力 | 已完成 | 从已锁定 DSH Runtime 交付 `read`、`glob`、`grep` 三个真实工作空间只读 Tool，不开放自定义创建 |
| Connector | 已完成 | DSH Runtime Connector 持久化协议、端点、授权边界、状态、延迟和最近检查时间 |
| Tool Version | 已完成 | Tool 固定为 `标识@1.0.0`，输入/输出 Schema 与风险等级存入 PostgreSQL；Agent/Skill 禁止裸标识引用 |
| 管理能力 | 已完成 | 管理后台可查看、启停、调整角色/数据范围/审批策略并执行健康检查，无自定义 Tool/Connector 创建入口 |
| 引用门禁 | 已完成 | Agent 和 Skill 创建、测试、发布以及 Runtime 快照均校验 Tool 已发布、只读、可用且 Connector 健康 |
| 依赖闭包 | 已完成 | Agent 必须显式包含所选 Skill 依赖的全部 Tool Version，不能借 Skill 扩大允许列表 |
| Runtime Allowlist | 已完成 | 不可变 Manifest 的 Tool 标识通过进程环境注入 DSH；全局执行守卫拒绝未列入清单的工具，策略缺失或格式错误时失败关闭 |
| 健康联动 | 已完成 | Runtime degraded/offline 时 Connector 与可用 Tool 联动降级；恢复健康后只恢复系统降级项，不覆盖人工停用 |
| 审计 | 已完成 | Tool 启停、权限变更和 Connector 健康检查写入管理审计；健康检查保留独立历史记录 |
| 自动化验证 | 已完成 | 单元测试覆盖 Allowlist 允许/拒绝和错误配置失败关闭；真实 PostgreSQL 测试覆盖目录、权限、启停、健康联动与 Agent/Skill 强引用 |

## 一期边界

- 本阶段的 Connector 是 DSH Runtime 到当前 Run 工作空间的受控连接，不是外部 API 或 MCP 服务。
- 不支持管理端上传代码、录入任意 API、注册 MCP Server 或创建自定义 Tool/Connector。
- `read`、`glob`、`grep` 仅面向当前 Run 授权工作空间；网络策略继续为 deny，写文件和命令工具不在 Allowlist 中。
- 首个企业知识/ERP/MES Connector 取决于真实接口、测试账号、字段口径与数据权限，D-05 继续保留为联合试点准入项。

## 复验命令

```bash
pnpm verify:m4:tool
pnpm ci:check

# 需要一个已迁移或空的测试 PostgreSQL 数据库
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m4:tool:integration
```
