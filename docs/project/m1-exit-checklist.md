# M1 退出检查表

更新时间：2026-08-30
当前结论：M1 DSH Runtime 技术 POC 的全部退出条件已满足，M1 Gate 于 2026-08-30 关闭。平台持久化、实时 Telemetry 脱敏投影和企业 Connector 属后续实施阶段，不再阻塞 Runtime 技术选型。

| 退出条件 | 状态 | 证据/阻塞 |
|---|---|---|
| DSH 版本、Commit、许可和入口固定 | 已满足 | `docs/poc/m1-runtime-poc.md` |
| 真实 DSH 程序化协议可启动 | 已满足 | `pnpm probe:m1`，ACP v1，Session 创建成功 |
| Manifest 不可变且可追溯 | POC 已满足 | canonical JSON、SHA-256、Attempt `manifest.json` |
| 每 Attempt 进程和目录隔离 | POC 已满足 | 并发自动化测试通过 |
| 标准事件不泄漏隐藏推理或敏感参数 | POC 已满足 | ACP 仅输出已提交消息和安全生命周期；Tool/usage 留在权威日志，后续经带脱敏规则的 Telemetry 投影 |
| 取消和超时可靠终止真实运行 | POC 已满足 | Mock 超时通过；`pnpm probe:m1:cancel` 验证真实模型请求约 255ms 收敛为 `cancelled` |
| 一个批准模型真实运行并记录 Token | POC 已满足 | `pnpm probe:m1:real` 完成真实回答；权威 Session Log 记录输入 `6111`、输出 `40` Token |
| 一个真实只读 Tool 可运行、鉴权和审计 | POC 已满足 | `pnpm probe:m1:tool` 在 workspace sandbox 中完成文件读取；日志记录 `tool/call=1`、`tool/result=1` |
| 输入只读、输出受控并形成成果 | POC 已满足 | `pnpm probe:m1:artifact` 验证输入未修改、仅收集 `output/`、成果字节数和 SHA-256；MVP 持久存储仍待 D-07 |
| 1/3/5 并发资源数据齐全 | POC 已满足 | 1/3/5 全部成功；峰值 Worker 进程树 RSS 分别为 167/492/829 MiB |
| 是否 Fork DSH 有最终结论 | 已满足 | 不 Fork；使用固定 Commit、ACP、权威 Session Log 和官方 Session Telemetry 扩展点 |

M2 开始把 POC 能力接入 Repository、状态机和持久化。M3 实现员工侧 SSE 事件，同时通过 DSH Session Telemetry 增加显式脱敏规则和 dsh-work 投影后端；不得直接启用无脱敏的 FULL OTel 导出。
