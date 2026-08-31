# M3 端到端垂直闭环退出检查

**评审日期：** 2026-08-30  
**工程结论：** M3 工程 Gate 已关闭，可进入 M4 MVP 功能完成阶段。企业 SSO 与首个企业只读 Tool 的联合试点仍受 D-03、D-05 约束，不属于本次合成数据工程 Gate 的虚假完成项。

| 工作项 | 结论 | 验收证据 |
|---|---|---|
| M3-01 Session/Run API | 已完成 | 动态命令路由创建 Session、Run、不可变 Attempt，并锁定 Agent Version 与模型路由快照 |
| M3-02 排队与调度 | 已完成 | PostgreSQL 条件更新原子认领；Runtime 容量、接收/排空/停用状态控制调度；单 Node 进程队列自动泵送 |
| M3-03 SSE | 已完成 | 事件先落库后发送；稳定 event ID、全 Run stream position、`Last-Event-ID` 断点续传和终态关闭 |
| M3-04 工作台真实运行 | 已完成 | 新对话、连续追问、流式回答、取消、重试、固定底部输入和刷新恢复全部调用真实 API |
| M3-05 团队工作空间 | 已完成 | 成员权限、空间内 Session、共享文件、成果数量和右侧信息来自 PostgreSQL |
| M3-06 文件上传与安全 | 已完成（MVP） | 20 MB、扩展名、路径约束、SHA-256、`FileSafetyScannerPort`、可执行签名拦截、状态与失败反馈；内容解析归 M4-05，企业 AV 归 D-07 |
| M3-07 Artifact | 链路保留 | 成果数据模型、来源 Run、不可覆盖版本、元数据预览、权限校验和真实下载保留；普通回答不再自动发布 Markdown，后续仅由明确的成果操作触发 |
| M3-08 模型记录 | 已完成 | Provider、模型、状态、Trace、延迟、成本字段入库；真实 DSH Run 从隔离 Session Log 记录 6192/42 Token，无法取证时显式标记 estimated |
| M3-09 Tool 审计 | 已完成（平台链路） | ACP 权限事件仅投影脱敏 Tool 名称/调用 ID；审计表记录用户、Run、Attempt、参数摘要、结果与 Trace；M1 已验证真实只读文件 Tool |
| M3-10 管理运行视图 | 已完成 | Runtimes、Session、工作空间、审计、模型用量、Usage 和系统健康均由 PostgreSQL/Runtime 实时投影 |

## 自动化与实际验证

- `pnpm test:m3:integration`：3 个 PostgreSQL 编排测试，覆盖事件重放、Artifact、用量、取消、重试、文件安全和 Tool 审计。
- `pnpm test:m2:integration`：5/5 通过，M2 迁移、模型治理和不可变 Attempt 无回归。
- `pnpm test:m1`：8/8 通过，Runtime Manifest、权限、取消、超时和隔离无回归。
- 真实 DSH 调用：ACP stdio 顺序产生 queued/started/delta/completed 事件；权威 Session Log 记录 6192 input Token、42 output Token。
- 浏览器：员工端创建、流式完成、取消、重试、刷新恢复、工作空间文件与 Artifact；管理端 Runtime、Session 和模型用量均已验收。

## 保留边界

- D-03 企业 SSO 仍未选型，当前使用服务端受控种子员工；不得用于真实企业数据试点。
- D-05 首个企业只读 Tool 仍取决于企业接口 Owner；M3 完成平台调用与审计通道，未伪造 ERP/MES 接口。
- D-07 正式 Artifact/文件对象存储与企业 AV 未确定；当前是可替换本地 Adapter 和基线安全扫描器。
- Agent/Skill 正式发布、企业 Connector、文件内容解析与上线运维属于 M4～M6。
