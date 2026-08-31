# M4-05 文件分析退出检查

**验证日期：** 2026-08-30

**工程结论：** M4-05 的文件上传、基础解析、不可变 Run 输入、DSH 只读挂载和结果追溯闭环已完成，可继续实施 M4-06 权限与数据范围。本结论不代表生产杀毒、OCR 或对象存储方案已经确定，也不关闭 M4 总 Gate。

| 验收项 | 结论 | 验收证据 |
|---|---|---|
| 员工端上传 | 已完成 | 新对话和追问都传递真实 `File`；先创建/复用 Session，再上传并取得 `fileId`，最后随 Run 提交 |
| 支持格式 | 已完成（MVP） | PDF、DOCX、XLSX、CSV、TXT、Markdown；单文件 1 B～20 MB，每次最多 5 个文件 |
| 安全前置 | 已完成（工程基线） | 扩展名白名单、体积限制和 `FileSafetyScannerPort` 在解析前失败关闭；当前默认扫描器是基础签名门禁，生产仍需接入杀毒引擎 |
| 基础解析 | 已完成 | PDF 文本层、DOCX 段落、XLSX 单元格、CSV 引号语义及纯文本解析；记录解析器版本、类型、摘要校验值和页/表/行统计 |
| 失败提示 | 已完成 | 无文本、错误签名、损坏 Office 容器、非法编码、未闭合 CSV、页数/行数/单元格/文本上限均返回具体错误；员工端显示服务端消息 |
| 权限过滤 | 已完成 | 文件必须属于当前 Session，或属于 Session 对应且当前用户为成员的工作空间；无权文件不进入 Runtime |
| Run 快照 | 已完成 | 每个 Attempt 通过 `run_input_files` 固化文件、解析版本和挂载路径；解析文本 SHA-256 写入不可变 Manifest |
| Runtime 挂载 | 已完成 | Adapter 仅允许 `/workspace/input/*.txt`，校验内容摘要，以排他创建写入 Attempt 隔离目录并设置 `0400` |
| 对话追溯 | 已完成 | 当前 Attempt 的输入文件名回传到员工对话 DTO；Run、Attempt、原文件、解析记录和成果可关联查询 |
| 自动化验证 | 已完成 | 单元测试覆盖六类解析分支中的基础样例和失败码；Runtime 测试覆盖摘要校验、路径约束、真实只读文件；PostgreSQL 测试覆盖上传、解析、Manifest、追溯和越权失败 |

## MVP 边界

- PDF 仅解析可提取的文本层，不提供 OCR、扫描件识别、表格版面还原、密码 PDF 或复杂字体映射；这类文件会得到“无可提取文本”或解析失败提示。
- DOCX/XLSX 采用无宏、无外链执行的只读 ZIP/XML 解析；XLSX 读取缓存单元格值，不计算公式，也不解析图片和图表。
- 当前基础扫描器只阻断已知可执行文件签名，不等价于生产杀毒、沙箱或 DLP。进入真实企业试点前必须替换 `FileSafetyScannerPort`。
- 本地文件目录是开发和单机 MVP 的存储适配器。D-07 仍需确定 NAS/对象存储、容量、保留周期、备份和清理策略。
- 解析文本随 Attempt Manifest 固化以保证复现；生产环境应结合 D-07/D-09 对数据库加密、保留和敏感数据出口进行配置。

## 当前环境复验状态

- M4-05 的解析单元测试、Runtime Adapter 只读挂载测试、真实 PostgreSQL 集成测试和全量 `ci:check` 均已通过。
- 随后复跑真实 DSH 模型探针和只读 Tool 探针时，两者都在没有发起权限请求、没有提交模型消息的情况下返回 `stopReason=cancelled`。纯模型探针同样失败，说明该现象位于当前 DSH 默认模型/凭据运行链路，不是文件路径、文件权限或 Tool Allowlist 单点导致。
- M1 留存的真实模型、只读 Tool 和 Artifact 成功证据仍是历史 POC 结论；但当前环境的真实模型 UAT 必须在 DSH 链路恢复并重新跑通 `pnpm probe:m1:real` 与 `pnpm probe:m1:tool` 后才能确认，不能以本次工程测试代替。

## 复验命令

```bash
pnpm verify:m4:file
pnpm test:m4:file
pnpm test:m1
pnpm ci:check

# 需要一个已迁移或空的测试 PostgreSQL 数据库
DSH_WORK_TEST_DATABASE_URL=postgres://... pnpm test:m4:file:integration
```
