# M4-02 Skill 管理退出检查

**验证日期：** 2026-08-30

**工程结论：** M4-02 已完成，可继续实施 M4-03 预置 Tool/Connector。该结论只关闭 Skill 管理工作项，不代表 M4 总 Gate 已关闭。

| 验收项 | 结论 | 验收证据 |
|---|---|---|
| 自动标识 | 已完成 | 创建 API 不接收 Skill 标识；服务端生成稳定 `skill-*` 标识，管理端只读展示和复制 |
| 创建与编辑 | 已完成 | 名称、分类、说明、执行指令、工具引用和典型问题持久化；创建人自动成为负责人 |
| 测试门禁 | 已完成（MVP） | 服务端保存测试问题、配置指纹、结果和测试人；配置变化使旧证据失效，未重新测试不能发布 |
| 版本管理 | 已完成 | 已发布版本不可原地修改；编辑已发布 Skill 自动创建下一小版本草稿；活动版本继续可供既有 Agent 使用 |
| 发布与启停 | 已完成 | 发布、启用、停用均持久化；停用后新 Agent 不能引用，既有 Agent Version 的历史引用不被改写 |
| 回滚 | 已完成 | 回滚只切换活动版本指针；版本历史与发布记录可在管理端查看 |
| Agent 引用 | 已完成 | Agent 草稿只能引用当前可用的已发布 Skill Version，引用格式固定为 `Skill 标识@版本` |
| Runtime 生效 | 已完成 | Run 创建时解析已锁定 Skill Version，将执行指令写入不可变 Manifest 并组合进 DSH System Prompt |
| 数据库与契约 | 已完成 | PostgreSQL 迁移、Skill 测试记录、发布记录、管理 API 和 OpenAPI 已落地 |
| 自动化验证 | 已完成 | 真实 PostgreSQL 测试覆盖自动标识、测试失效、两版发布、Agent 锁定旧版、回滚、停用/启用和版本不可变 |

## MVP 测试边界

- Skill 编辑器维护发布校验问题；发布时必须通过服务端配置校验门禁。
- 服务端测试验证指令、工具引用、典型问题和配置指纹，不调用真实模型或企业系统。
- 已发布 Skill 的指令会在员工真实 Run 中进入 DSH，因而不是只存在于管理后台的展示数据。

## 保留边界

- M4-03 已把工具目录切换为真实 PostgreSQL 投影，并补齐预置 Tool Version、健康状态、引用可用性强校验和 DSH 执行前 Allowlist；企业 Tool 仍以 D-05 的真实接口就绪为准。
- 企业 SSO 仍受 D-03 约束；当前负责人和操作人来自服务端受控种子用户。
- Skill 不保存 Provider、密钥或模型策略，也不能绕过 Agent、角色、数据范围和 Tool 权限。

## 复验命令

```bash
pnpm verify:m4:skill
pnpm ci:check

# 需要一个已迁移或空的测试 PostgreSQL 数据库
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m4:skill:integration
```
