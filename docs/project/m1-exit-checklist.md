# M1 退出检查表

更新时间：2026-08-30
当前结论：M1 第一阶段已通过，Adapter 和真实 DSH ACP 协议可行；真实模型、Tool、文件和资源基线尚未完成，M1 Gate 保持开放。

| 退出条件 | 状态 | 证据/阻塞 |
|---|---|---|
| DSH 版本、Commit、许可和入口固定 | 已满足 | `docs/poc/m1-runtime-poc.md` |
| 真实 DSH 程序化协议可启动 | 已满足 | `pnpm probe:m1`，ACP v1，Session 创建成功 |
| Manifest 不可变且可追溯 | POC 已满足 | canonical JSON、SHA-256、Attempt `manifest.json` |
| 每 Attempt 进程和目录隔离 | POC 已满足 | 并发自动化测试通过 |
| 标准事件不泄漏隐藏推理或敏感参数 | 部分满足 | 生命周期与提交消息已过滤；Tool/usage observer 待实现 |
| 取消和超时可靠终止真实运行 | 部分满足 | Mock ACP 通过；真实模型/Tool 运行中测试待 D-02/D-05 |
| 一个批准模型真实运行并记录 Token | 未满足 | D-02 待确定 |
| 一个真实只读 Tool 可运行、鉴权和审计 | 未满足 | D-05 待确定 |
| 输入只读、输出受控并形成成果 | 未满足 | D-07 待确定 |
| 1/3/5 并发资源数据齐全 | 未满足 | 需要真实链路 |
| 是否 Fork DSH 有最终结论 | 待最终评审 | 当前建议不 Fork，待 observer 验证 |

在 Gate 关闭前可以并行开展不依赖真实模型的 M2 Repository、迁移与状态机骨架，但不得宣称真实 AI 主链路完成。
