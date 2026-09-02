# dsh-work 文档导航

`docs/` 是项目方案、架构、契约、实施证据和运维说明的唯一存放目录。仓库根目录只保留项目入口 `README.md`，避免方案在多个位置形成互相冲突的副本。

## 核心文档

| 文档 | 作用 | 事实范围 |
|---|---|---|
| [产品与系统架构总览](architecture/overview.md) | 产品范围、系统边界、逻辑/部署架构、安全与演进原则 | 当前架构基线 |
| [MVP 路线图与交付状态](project/mvp-roadmap.md) | 里程碑结论、开放 Gate 和下一步 | 当前实施状态 |
| [数据模型](data-model.md) | 领域关系、表和关键约束 | 逻辑数据基线 |
| [决策台账](project/decision-register.md) | 已确认决策、外部依赖和变更规则 | 决策事实 |
| [风险台账](project/risk-register.md) | 风险、触发信号、Owner 与缓解措施 | 风险事实 |

## 契约与运行

- `contracts/openapi-workbench.json`：员工端 OpenAPI；
- `contracts/openapi-admin.json`：管理端 OpenAPI；
- [内部端口契约](contracts/internal-ports.md)：Repository、Runtime、Gateway 等内部边界；
- `contracts/runtime-manifest.schema.json`：不可变 Runtime Manifest Schema；
- `contracts/run-event.schema.json`：标准 Run Event Schema；
- [M1 Runtime POC](poc/m1-runtime-poc.md)：DSH ACP、版本、事件与探针结论；
- [Runtime 交付基线](deployment/dsh-runtime-delivery.md)：运行时安装、启动、升级与回滚。

## 身份与部署

- [AI Hub 身份接入说明](deployment/ai-hub-sso-integration.md)：应用环境、OIDC 回调、初始管理员、员工目录和本地授权联调步骤；
- [Mac mini 生产部署](deployment/mac-mini-production.md)：独立部署边界、公开仓库不可变 Release、自动监听部署、launchd、Docker Desktop、备份与回滚；
- [M6 AI Hub SSO 检查清单](project/m6-ai-hub-sso-checklist.md)：代码完成项与平台侧待办；
- [持续集成基线](project/ci-integration.md)：统一质量 Gate 与 CI 要求；
- [本地开发环境 UAT 报告](project/local-development-uat-report.md)：最近一次本地联调证据。

## 基线、测试与验收

- [M0 原型基线](baselines/m0-prototype-baseline.md)：已确认的信息架构和交互边界；
- [MVP 测试数据](testing/mvp-test-data.md) 与 `testing/fixtures/mvp-fixtures.json`：合成测试数据；
- `project/m0-exit-checklist.md` ～ `project/m4-exit-checklist.md`：M0～M4 Gate 记录；
- `project/m4-*-checklist.md`：M4 九项能力的工程证据；
- `project/m5-*-checklist.md` 与 `project/m5-capacity-test-report.md`：测试、安全、故障与容量证据。

这些检查表记录“当时验证了什么”，不替代当前实施状态。阅读项目现状时先看 [MVP 路线图与交付状态](project/mvp-roadmap.md)，需要追溯结论时再进入对应检查表。

## 文档优先级

同一主题出现差异时，按以下规则处理：

1. API 行为以 `contracts/` 下的可执行契约和服务端契约测试为准；
2. 物理数据结构以 `server/migrations/` 为准，`data-model.md` 负责解释逻辑关系；
3. 当前实现状态以 `project/mvp-roadmap.md` 和最新 Gate 检查表为准；
4. 产品范围与长期边界以 `architecture/overview.md` 为准；
5. 新决策先写入 `project/decision-register.md`，再同步受影响的架构、契约和检查表。

## 维护规则

- 不在仓库根目录新增方案、架构、评审或实施计划副本；
- 不在架构文档内复制完整 OpenAPI、DDL 或测试记录，只链接其权威来源；
- 已关闭里程碑保留检查表作为证据，不继续在历史长文中追加流水账；
- 任何“已完成”结论必须指向代码、契约、测试或可复现命令；
- 过时方案从工作树删除，历史版本通过 Git 记录追溯。

本次整理已将原根目录的产品设计、简化架构、MVP 实施长文和前端评审说明归并到上述单一事实来源，不再保留重复副本。
