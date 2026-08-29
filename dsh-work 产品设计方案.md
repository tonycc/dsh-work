# dsh-work 产品设计方案

**项目名称：** dsh-work
**产品名称：** dsh-work
**英文定位：** Enterprise AI Agent Workspace
**中文定位：** 企业 AI Agent 工作台
**方案版本：** V1.5
**方案日期：** 2026-08-29
**文档状态：** 原型已确认，MVP 实施基线
**当前阶段：** MVP 技术 POC 与实施准备
**目标形态：** 企业统一 AI 工作平台
**Agent Runtime：** DeepSeek Harness（DSH，可替换）
**首期部署：** 公司内网 Mac mini
**实施计划：** [《dsh-work MVP 实施方案与计划》](dsh-work%20MVP%20实施方案与计划.md)

> 核心决策：逻辑架构按企业平台设计，dsh-work 业务应用长期采用模块化单体；DSH Worker 以独立进程保障执行隔离，AI Hub 通过契约承接治理能力，不以微服务拆分作为演进目标。

---

# 一、方案摘要

dsh-work 是面向企业员工的统一 AI Agent 工作台。员工通过公司内网浏览器，以自然语言提出任务，dsh-work 根据权限调用企业知识、ERP、MES、文件分析和成果生成能力，最终交付答案、分析结论、异常清单或可下载文件。

dsh-work 不是 DSH 的简单套壳。两者职责如下：

| 层面 | 核心职责 |
|---|---|
| dsh-work | 员工入口、身份权限、Agent 发布、Workspace、Session、Run、文件、成果、审计和运营 |
| DSH | 某一次 Run 内的任务理解、规划、模型调用、Tool 调用和运行事件 |
| 企业扩展层 | 将身份、Runtime Manifest、模型、Tool、Artifact、凭证和 Telemetry 安全接入 DSH |

MVP 的物理架构保持轻量：

    员工浏览器
        ↓ 公司内网 HTTPS
    Reverse Proxy
        ↓
    dsh-work 模块化单体
        ├─ 身份与权限
        ├─ Agent Registry
        ├─ Workspace / Session / Run
        ├─ Model Gateway 模块
        ├─ Connector Gateway 模块
        ├─ Artifact Service 模块
        ├─ Runtime Adapter
        └─ 审计与管理
                ↓
        隔离的 DSH Worker
           ├─ 经 Model Gateway 调用模型
           ├─ 经 Connector Gateway 调用企业系统
           └─ 经 Artifact Service 交付成果

首期员工端只提供一个统一入口：

> dsh-work Assistant

它通过固定版本的 Skill 和类型化 Tool 完成三类核心任务：

1. 企业知识查询；
2. ERP、MES 只读业务查询；
3. 文件分析及报告生成。

---

# 二、项目背景、定位与目标

## 2.1 项目背景

企业内部普遍存在以下问题：

- 企业制度、产品资料和业务知识分散；
- 员工需要登录多个系统查询订单、库存、生产和采购数据；
- Excel、PDF、Word 等文件处理依赖重复人工劳动；
- 不同部门重复开发模型连接、文件能力、权限和审计；
- 通用大模型不能直接、安全地访问企业内部数据；
- 零散 Agent 缺少统一入口、稳定运行、成本治理和成果追溯。

传统方式：

    员工
    ├─ 查询知识库
    ├─ 登录 ERP
    ├─ 登录 MES
    ├─ 查找和整理文件
    ├─ 汇总数据
    └─ 编写报告

dsh-work 方式：

    员工提出任务
        ↓
    dsh-work 识别身份、权限和工作上下文
        ↓
    Agent 调用受控知识、业务和文件工具
        ↓
    返回结论、来源和可继续使用的成果

## 2.2 产品定义

> dsh-work 是企业员工通过自然语言安全使用企业知识、业务数据和 AI Agent 能力的统一工作台。

它同时承担四种角色：

| 角色 | 作用 |
|---|---|
| 企业 AI 入口 | 员工统一提交问题和工作任务 |
| Agent 工作台 | 展示任务状态、工具调用和业务化执行步骤 |
| 成果交付平台 | 交付报告、表格、文档和分析文件 |
| 企业治理平台 | 管理权限、版本、模型、工具、审计、成本和安全边界 |

## 2.3 MVP 目标

### 统一入口

- 员工通过公司内网浏览器访问；
- 不安装客户端；
- 不直接使用 DSH Web UI；
- 不要求员工理解 Agent、Skill、Tool 和模型的技术差异。

### 连接企业知识和业务数据

通过类型化、只读 Tool 查询：

- 企业制度和产品资料；
- 销售订单；
- 生产工单和生产进度；
- 库存；
- 采购到货计划；
- 产品追溯及其他经批准的数据。

### 交付可使用成果

支持：

- 知识回答和引用来源；
- 文件内容总结；
- Excel 或 CSV 数据分析；
- 异常清单；
- Markdown、XLSX、DOCX、PDF 等成果；
- 成果版本、下载和追溯。

### 建立最小企业治理

必须具备：

- 企业身份识别；
- 部门、角色和数据范围；
- Agent 和 Tool 使用权限；
- 任务、模型、Tool 和 Artifact 审计；
- 模型用量记录；
- 文件权限、保留和清理策略。

### 验证业务价值

MVP 要回答：

- 员工是否愿意重复使用统一 AI 工作台；
- 哪些任务最有价值；
- 哪些 Tool 使用频率最高；
- 哪些成果能够明显减少人工整理时间；
- 哪些数据允许进入外部模型；
- Mac mini 的容量是否满足部门试点。

## 2.4 非目标

MVP 阶段不建设：

- 完整的多 Agent 市场；
- 可视化 Agent Studio；
- 员工自由安装第三方插件或 MCP；
- 管理员通过管理后台在线注册或编辑自定义 Tool；
- 管理员通过管理后台自助接入 API、MCP Server、数据库或其他 Connector；
- 大规模多 Agent 团队；
- 跨天无人值守任务；
- 企业数据中台；
- ERP 替代系统；
- 完整桌面自动化；
- 每名员工一套本地大模型；
- 专业办公软件的全部精细编辑能力；
- 自动付款、自动审批和正式 ERP 写入。

---

# 三、目标用户与核心场景

## 3.1 目标用户

| 用户角色 | 典型需求 | 主要权限 |
|---|---|---|
| 普通员工 | 查询制度、分析文件、生成报告 | 使用已授权的知识和文件能力 |
| 销售人员 | 查询订单、交付和库存 | 查询本人或本部门授权订单 |
| 生产人员 | 查询工单、进度、缺料 | 查询授权工厂和生产数据 |
| 采购人员 | 查询采购订单和到货计划 | 查询授权采购范围 |
| 部门负责人 | 使用部门能力、查看使用效果 | 使用部门 Agent，查看汇总指标 |
| 业务专家 | 沉淀业务方法和规则 | 提交 Skill 变更，不直接生产发布 |
| Agent 开发者 | 配置 Prompt、Skill 和 Tool | 开发、测试和提交发布 |
| 平台管理员 | 管理系统配置和运行状态 | 平台管理，不自动拥有业务数据权限 |
| 安全审计人员 | 检查权限、出口和调用记录 | 只读查看授权审计信息 |

## 3.2 企业知识查询

示例：

> 公司的委外加工业务应该如何处理发料和库存扣减？

执行流程：

    识别知识查询任务
        ↓
    校验知识目录权限
        ↓
    检索制度、SOP 和相关说明
        ↓
    组织回答并标记依据
        ↓
    返回文档名称、版本或更新时间

结果要求：

- 明确回答问题；
- 列出来源；
- 无依据时明确说明；
- 不编造企业制度；
- 记录使用的知识版本。

## 3.3 ERP、MES 业务查询

示例：

> 查询订单 SO20260821001 当前生产进度，判断是否存在缺料风险。

执行流程：

    查询销售订单
        ↓
    查询关联生产工单
        ↓
    查询生产完成进度
        ↓
    查询物料库存
        ↓
    查询采购到货计划
        ↓
    根据固定 Skill 判断风险
        ↓
    输出风险清单和建议

模型只负责理解任务、选择工具和组织结果。真实数据查询、权限校验、字段过滤和业务对象范围由 Connector Gateway 及工具后端负责。

## 3.4 文件分析与报告生成

示例：

> 分析本月销售情况，识别下降最大的产品，生成一份经营分析报告。

执行流程：

    上传文件
        ↓
    文件格式、安全和权限检查
        ↓
    提取表格或文档结构
        ↓
    计算指标并识别异常
        ↓
    生成分析结论
        ↓
    生成可下载成果

交付内容：

- 页面分析摘要；
- 异常产品清单；
- 可下载表格；
- DOCX 或 PDF 报告；
- 输入文件、Run 和生成版本的追溯关系。

## 3.5 组合型业务任务

示例：

> 根据这份生产计划，结合 ERP 库存和采购到货计划，列出下周可能缺料的订单。

这类任务组合：

- 用户上传文件；
- ERP、MES 或 WMS Tool；
- 业务分析 Skill；
- 报告或表格生成 Tool。

“文件 + 企业系统 + 业务规则 + 成果交付”是 dsh-work 相对于普通聊天机器人的核心价值。

# 四、产品与架构设计原则

## 4.1 一个入口优先

首期员工端只提供一个 dsh-work Assistant。系统在后台根据任务选择固定版本的 Skill 和 Tool。

底层必须保留 Agent 和 Agent Version 对象，为后续发布知识问答、数据分析等独立 Agent 做准备。

## 4.2 逻辑边界稳定，物理部署简单

- 领域对象和接口按平台化目标设计；
- dsh-work 业务应用在 MVP 和生产阶段均默认使用模块化单体，不采用业务微服务；
- Model Gateway、Connector Gateway 和 Artifact Service 是独立逻辑模块，默认与控制面处于同一代码库和业务部署单元；
- DSH Worker 使用独立进程或进程池，解决资源、故障和上下文隔离问题，不作为微服务；
- 生产环境可以部署多个相同的 `dsh-work-app` 实例，通过负载均衡和共享存储提高可用性；
- 如果网络安全或重计算任务要求独立进程，只增加无业务状态的隔离适配器，不拆分业务领域、数据库所有权或分布式事务。

## 4.3 只读优先

MVP 允许：

- 查询知识；
- 查询授权业务数据；
- 分析上传文件；
- 创建新的成果文件。

MVP 禁止：

- 修改正式 ERP 单据；
- 修改库存；
- 自动付款或审批；
- 覆盖原始文件；
- 任意 SQL；
- 任意 Shell；
- 未经批准的互联网访问。

## 4.4 身份由后端注入

可信身份上下文由 dsh-work 后端注入：

    {
      "user_id": "U10086",
      "department_id": "D020",
      "roles": ["production_manager"],
      "data_scopes": ["factory-01", "warehouse-01"],
      "workspace_id": "ws_001",
      "session_id": "session_001",
      "run_id": "run_001",
      "agent_version_id": "dsh-work-assistant@1"
    }

模型只提供业务参数：

    {
      "order_no": "SO20260821001"
    }

用户身份、部门、角色和数据范围不得由模型填写或覆盖。

## 4.5 结果交付优先

dsh-work 不只返回聊天答案，还应交付：

- 数据来源；
- 查询对象；
- 分析表格；
- 报告；
- 异常清单；
- Artifact 下载；
- 可追溯的输入和版本关系。

## 4.6 默认可审计

每个 Run 必须能够回答：

- 谁发起；
- 位于哪个 Workspace 和 Session；
- 使用哪个 Agent Version；
- 使用哪些 Skill；
- 调用哪些模型和 Tool；
- 查询哪些业务对象；
- 产生哪些 Artifact；
- 使用多少 Token；
- 是否等待审批；
- 最终成功、失败、取消还是超时。

## 4.7 Runtime 可替换

dsh-work 业务模块只能依赖统一 Runtime Adapter，不依赖 DSH 内部 Session、Preset、Profile 或事件格式。

## 4.8 产品事实与运行日志分离

- dsh-work 数据库是 User、Workspace、Session、Run 和 Artifact 的产品事实来源；
- DSH Session Log 是 Runtime 内部技术轨迹；
- DSH 日志可用于诊断和恢复，但不能作为唯一业务数据库。

---

# 五、产品信息架构与页面

## 5.1 产品信息架构

    dsh-work
    ├─ 工作台
    │  ├─ 统一新对话输入
    │  ├─ 文件和企业数据入口
    │  ├─ 能力快捷栏
    │  └─ 最近对话
    ├─ 对话
    │  ├─ 连续消息流
    │  ├─ 固定底部输入
    │  ├─ Run 状态和业务化执行步骤
    │  ├─ Tool、来源、审批和成果详情
    │  └─ 停止、失败重试和继续追问
    ├─ 工作空间
    │  ├─ 团队工作空间列表
    │  └─ 工作空间详情
    │     ├─ 对话
    │     ├─ 共享文件
    │     ├─ 成果
    │     └─ 成员、责任团队与权限
    ├─ 我的成果
    │  ├─ 版本与来源 Run
    │  ├─ 预览
    │  └─ 下载
    ├─ 用户中心（左下角用户入口）
    │  ├─ 个人信息
    │  ├─ 输出偏好
    │  └─ 数据使用提示
    └─ 管理后台
       ├─ 运营概览
       ├─ Agent 管理
       ├─ Skill、预置 Tool 与 Connector
       ├─ Runtimes 与 Session 列表
       ├─ 工作空间、成员与权限
       ├─ 模型用量和审计记录
       └─ 系统健康

## 5.2 工作台

工作台保持一个主要输入焦点：

    ┌─────────────────────────────────────────┐
    │ dsh-work                                 │
    │ 企业 AI Agent 工作台                    │
    │                                         │
    │  ┌───────────────────────────────────┐  │
    │  │ 请描述需要完成的工作……            │  │
    │  │                                   │  │
    │  │ [上传文件]              [发送任务]│  │
    │  └───────────────────────────────────┘  │
    │                                         │
    │ 能力快捷入口                            │
    │ [查询订单] [生产进度] [库存分析]        │
    │ [制度查询] [分析 Excel] [生成报告]      │
    │                                         │
    │ 最近对话                                │
    └─────────────────────────────────────────┘

## 5.3 对话页面

对话页面采用中心消息流和固定底部输入，并将运行明细收进详情区：

1. 对话和最终答案；
2. 经过整理的业务执行步骤；
3. Tool 状态和审批；
4. 数据来源和查询对象；
5. Artifact 预览、版本和下载。

不得向员工暴露模型内部思维链。只展示可验证的业务步骤和运行状态，例如：

    ✓ 已识别订单编号
    ✓ 已查询销售订单
    ✓ 已查询生产工单
    ✓ 已查询库存
    ● 正在生成缺料风险分析

## 5.4 最小管理后台

MVP 管理后台实现：

- 用户和角色查看；
- Agent Version 启停和发布记录；
- Skill 创建、版本发布和查看；
- 预置 Tool 目录、权限配置和启停；
- 预置 Connector 状态查看和健康检查；
- Runtime 健康、容量、最大并发、超时和调度状态；
- Session 运行元数据列表；
- 团队工作空间治理视图；
- 数据范围配置；
- Run、Tool、模型和 Artifact 审计；
- 模型调用量；
- 系统健康状态。

MVP 不实现可视化 Agent 编排器，也不提供自定义 Tool 注册、Tool Schema 在线编辑、Connector 创建或连接参数在线编辑。首期 3～5 个只读业务 Tool 及其 Connector 由实施团队通过代码、受控配置和部署流程预置；管理后台只承担查看、权限、启停和健康检查。

---

# 六、核心领域模型

## 6.1 核心对象

| 对象 | 定义 | 生命周期和归属 |
|---|---|---|
| User | 企业员工或管理员身份，绑定部门、角色和数据范围 | 长期；dsh-work 管理 |
| Agent | 可复用的业务能力入口 | 长期；dsh-work 管理 |
| Agent Version | 确定版本的 Prompt、Skill、Tool、模型和权限策略 | 发布后不可变；Run 创建时锁定 |
| Workspace | 围绕项目持续工作的空间，包含文件、Session 和 Artifact | 长期；个人或团队 |
| Session | 一个连续对话主题 | 长期；包含多个 Run |
| Run | 用户每次提交后产生的一次任务执行 | 可排队、取消、重试、完成或失败 |
| Runtime Attempt | 完成一个 Run 的一次具体 Worker 尝试 | 短期；系统重试产生新 Attempt |
| Artifact | Run 生成或修改的成果文件 | 长期；支持版本、权限和追溯 |
| DSH Session Log | DSH 内部追加式执行事件 | 技术轨迹；归档用于诊断 |

## 6.2 对象关系

    User
      └─ Workspace (1:N)
           ├─ Member (1:N)
           ├─ File (0:N)
           ├─ Session (1:N)
           │    └─ Run (1:N)
           │         ├─ Runtime Attempt (1:N)
           │         └─ Artifact (0:N)
           └─ Artifact (0:N)

    Agent
      └─ Agent Version (1:N)
           └─ Run 在创建时锁定一个具体版本

## 6.3 Session、Run 与 Attempt 边界

| 对象 | 回答的问题 |
|---|---|
| Session | 用户正在持续讨论什么主题 |
| Run | 用户这一次提交需要完成什么任务 |
| Attempt | Runtime 这一次具体执行是否成功 |

规则：

- 用户继续追问会创建新的 Run，不复用上一个 Run；
- 系统级失败重试在同一个 Run 下创建新的 Attempt；
- 用户修改需求后重新提交，应创建新的 Run；
- Run 锁定 Agent Version、Skill 版本、Tool Allowlist 和模型策略；
- Runtime 是否复用不能改变产品对象和审计关系。

## 6.4 Workspace 隔离

- 一期只支持团队 Workspace，不创建个人 Workspace；
- 团队 Workspace 属于责任团队，不绑定在创建人个人名下；
- 团队 Workspace 通过显式成员和角色共享；
- Session、文件和 Artifact 继承 Workspace 权限；
- 每次 Tool 调用仍需携带当前用户和业务数据范围；
- 共享 Workspace 不等于共享所有 ERP、MES 或其他业务数据。

## 6.5 Artifact 版本模型

- Artifact 由稳定 artifact_id 标识；
- 每次修改产生新 artifact_version；
- V2、V3 不覆盖 V1；
- 每个版本记录来源 Run、Agent Version、Skill、模型、Tool 和输入文件；
- 已发布版本不可原地覆盖；
- 删除和保留策略由权限与合规配置决定。

---

# 七、总体架构

## 7.1 逻辑架构

    用户体验层
      员工 Web / 管理后台 / 后续桌面端
            ↓
    企业接入与安全层
      SSO / API Gateway / RBAC / ABAC / 限流 / DLP
            ↓
    控制面
      Agent Registry / Skill Registry / Tool Registry
      Workspace / Session / 权限 / 发布治理
            ↓
    执行控制层
      Run 模块 / 应用内调度 / Approval / Event Stream
            ↓
    Runtime Adapter
      Runtime Manifest / 标准 Run Event / DSH Adapter
            ↓
    DSH Runtime
      Headless Worker / Agent Loop / Skill / Tool Call / Session Log
            ↓
    平台能力边界
      Model Gateway / Connector Gateway / Artifact Service
            ↓
    基础设施
      PostgreSQL / 文件或对象存储 / 密钥 / 监控 / 审计

## 7.2 MVP 物理部署

逻辑模块不等于独立服务。MVP 的物理部署为：

    Mac mini
    ├─ reverse-proxy
    ├─ dsh-work-app
    │  ├─ Vue 静态页面
    │  ├─ Node.js API
    │  ├─ Identity / Agent / Workspace / Session / Run
    │  ├─ Model Gateway 模块
    │  ├─ Connector Gateway 模块
    │  ├─ Artifact Service 模块
    │  ├─ Audit 模块
    │  └─ Runtime Adapter
    ├─ DSH Worker 子进程
    ├─ PostgreSQL
    └─ persistent-data
       ├─ uploads
       ├─ workspaces
       ├─ artifacts
       ├─ runtime-logs
       └─ backups

MVP 不强制引入：

- Redis；
- RabbitMQ；
- MinIO；
- Vault；
- Kubernetes；
- Service Mesh；
- 业务微服务。

对应替代方式：

| 目标能力 | MVP 实现 |
|---|---|
| Queue | PostgreSQL 状态表和应用内调度 |
| Artifact Storage | 本地持久化目录或企业 NAS |
| Secret | 容器 Secret、macOS Keychain 或受控配置 |
| Worker Isolation | 独立进程、目录、环境变量和超时 |
| Telemetry | 结构化日志、数据库审计和基础指标 |
| Model Gateway | 单体内部模块和稳定接口 |
| Connector Gateway | 单体内部模块和统一调用管线 |

## 7.3 模块化单体边界

    dsh-work-app
    ├─ identity
    ├─ users-and-roles
    ├─ agents
    ├─ skills
    ├─ tool-registry
    ├─ workspaces
    ├─ sessions
    ├─ runs
    ├─ runtime-adapter
    ├─ model-gateway
    ├─ tool-gateway
    ├─ files
    ├─ artifacts
    ├─ audit
    ├─ usage
    └─ admin

模块之间通过清晰接口协作，不直接读取对方内部表或依赖 DSH 内部对象。

## 7.4 长期生产架构（非微服务）

生产化不改变 dsh-work 的业务部署边界。身份、Workspace、Session、Run、Runtime Adapter、Model Gateway、Connector Gateway、Artifact Service、审计和管理能力继续属于同一个模块化单体。容量和高可用通过相同应用多实例、共享数据库或存储、独立 DSH Worker 进程池解决，不通过拆分业务微服务解决。

默认生产形态：

    员工浏览器
        ↓
    Reverse Proxy / Load Balancer / HTTPS
        ↓
    dsh-work-app（模块化单体，可部署多个相同实例）
        ├─ Agent Gateway / Identity
        ├─ Agent Hub / GovernancePort Client
        ├─ Workspace / Session
        ├─ Run / Attempt / 应用内调度
        ├─ Runtime Adapter / Worker Manager
        ├─ Model Gateway 模块
        ├─ Connector Gateway 模块
        ├─ Artifact Service 模块
        └─ Audit / Admin / Observability
                │
                ├────────► DSH Worker 独立进程池
                ├────────► PostgreSQL
                ├────────► NAS / 对象存储
                ├────────► 内部或外部模型
                ├────────► 企业业务系统
                └────────► AI Hub Governance（达到治理门槛后）

生产化可以按证据增加：

- 多个相同的 `dsh-work-app` 实例和负载均衡；
- 独立主机上的 DSH Worker 进程池；
- PostgreSQL 高可用、NAS 或对象存储；
- Redis/MQ、Vault/KMS、OpenTelemetry 等共享基础设施；
- 企业已有 API Gateway、模型网关或 Connector 网络代理。

上述变化不改变业务模块归属，不要求为 Workspace、Run、Model、Connector 或 Artifact 建立独立服务和独立数据库。Kubernetes 可以作为可选部署工具，但不是产品架构成熟度或生产化的前提。

---

# 八、DSH 集成与运行设计

## 8.1 DSH 定位

DSH 仅作为可替换的 Agent Runtime 内核，负责：

- Agent Loop；
- 模型调用过程；
- Tool Call；
- Skill 执行；
- 运行时上下文；
- Session Event Log；
- 基础 Sandbox 和 Guard。

DSH 不负责：

- 员工和组织；
- Agent 发布管理；
- Workspace 权限；
- 企业业务数据权限；
- Artifact 长期版本；
- 跨用户任务排队；
- 企业模型和成本治理；
- 正式员工 Web。

## 8.2 Runtime Adapter

dsh-work 业务代码只依赖统一接口：

    interface AgentRuntime {
      execute(input: ExecuteRunInput): Promise<RuntimeAttempt>;
      subscribe(
        attemptId: string,
        listener: RuntimeEventListener
      ): Unsubscribe;
      cancel(attemptId: string): Promise<void>;
      status(attemptId: string): Promise<RuntimeStatus>;
      close(attemptId: string): Promise<void>;
      health(): Promise<RuntimeHealth>;
    }

Runtime Adapter 负责：

- 将 Run 编译为 Runtime Manifest；
- 启动 DSH Worker；
- 转换 DSH 原始事件；
- 处理取消、超时和关闭；
- 隔离 DSH 版本变化；
- 返回稳定的 Attempt 结果；
- 保存必要诊断信息。

## 8.3 Runtime Manifest

每个 Attempt 启动时生成不可变 Manifest：

    {
      "run_id": "run_001",
      "attempt_id": "attempt_001",
      "workspace_id": "ws_001",
      "session_id": "session_001",
      "agent_version_id": "dsh-work-assistant@1",
      "user": {
        "id": "u_1001",
        "department": "production"
      },
      "data_scopes": ["factory:01", "warehouse:01"],
      "profile": "dsh-work-office",
      "skills": [
        "enterprise-knowledge@1.0.0",
        "shortage-analysis@1.0.0"
      ],
      "tools": [
        "knowledge.search",
        "erp.get_sales_order",
        "mes.get_work_order_progress"
      ],
      "model_policy": "approved-general",
      "permission_policy": "readonly",
      "input_mount": "/workspace/input",
      "output_mount": "/workspace/output"
    }

## 8.4 标准 Run Event

产品层统一使用：

    run.created
    run.queued
    run.started
    model.started
    model.completed
    tool.requested
    tool.approval_required
    tool.started
    tool.completed
    tool.failed
    artifact.created
    artifact.updated
    run.completed
    run.failed
    run.cancelled
    run.timeout

事件至少包含：

- event_id；
- run_id；
- attempt_id；
- event_type；
- occurred_at；
- display_message；
- technical_code；
- safe_metadata；
- trace_id。

展示给员工的 display_message 必须是业务化说明，不暴露内部思维链和敏感参数。

## 8.5 Run 状态机

    created
       ↓
    queued
       ↓
    starting
       ↓
    running
       ├─→ waiting_approval ─→ running
       ├─→ completed
       ├─→ failed
       ├─→ cancelled
       └─→ timeout

规则：

- completed、failed、cancelled 和 timeout 为终态；
- 系统重试创建新 Attempt；
- 用户重提或继续追问创建新 Run；
- 取消必须同时更新产品状态并终止 Worker；
- Worker 异常不得破坏 Session 和已有 Artifact。

## 8.6 Worker 生命周期与隔离

默认采用一 Run 一 Worker：

- 一个 Worker 同时只服务一个 Run；
- 每个 Attempt 有独立目录、环境变量和事件上下文；
- 输入只读挂载；
- 输出只能写当前 Attempt 目录；
- 完成、取消或超时后回收；
- 业务凭证使用短期或最小权限凭证；
- Worker 不对员工网络开放端口。

MVP 可在同一用户、同一 Workspace、同一 Session 下短时间复用 Worker 作为性能优化，但必须满足：

- 不跨用户；
- 不跨 Workspace；
- 每个 Run 仍拥有独立 Attempt 和审计；
- 系统不依赖 Worker 内存作为唯一上下文；
- 达到空闲时间后关闭；
- 任意重启后可以从产品层上下文继续。

## 8.7 DSH Profile 与插件策略

- 不为每个业务 Agent 创建一个 DSH Profile；
- Profile 只表达基础安全运行环境；
- 首期建议固定 office、knowledge、data 三类；
- 生产环境只加载审核后的固定 Bundle；
- 禁止员工动态安装插件；
- Skill 固定版本并通过发布流程；
- 只有扩展机制无法实现稳定取消、恢复或协议时，才维护最小内部 Fork。

## 8.8 版本治理

由于 Runtime 能力可能变化：

- 固定精确 DSH 版本或 Commit；
- 建立 Adapter 契约测试；
- 建立 Manifest、事件、取消、Tool 和 Artifact 回归测试；
- 新版本先进入升级沙箱；
- 保留回滚版本；
- 不将 DSH 内部结构写入业务 API 或核心数据表。

---

# 九、核心平台模块

## 9.1 员工 Web

主要功能：

- 企业登录；
- 自然语言输入；
- 文件上传；
- 快捷任务；
- 流式状态；
- 任务停止；
- 失败重试；
- 继续追问；
- 来源展示；
- Artifact 预览和下载；
- 最近对话快速回访。

## 9.2 Agent Registry

MVP 功能：

- Agent 基本信息；
- Owner；
- 可见范围；
- Agent Version；
- Prompt、Skill、Tool、可见角色和数据范围；
- Draft、Published、Disabled 状态；
- 发布和回滚记录。

MVP 通过管理后台和本地 GovernancePort 写入 PostgreSQL，并生成不可变 Agent Version。YAML/Git 仅用于实施团队维护预置种子和可审查 Bundle，不作为管理员在线修改后的唯一事实来源。

    id: dsh-work-assistant
    name: dsh-work Assistant
    owner: ai-platform
    model_policy: approved-general
    skills:
      - enterprise-knowledge@1.0.0
      - order-analysis@1.0.0
      - shortage-analysis@1.0.0
      - spreadsheet-analysis@1.0.0
      - report-generation@1.0.0
    tools:
      - knowledge.search
      - erp.get_sales_order
      - mes.get_work_order_progress
      - wms.get_material_inventory
      - procurement.get_delivery_plan
      - document.extract
      - spreadsheet.analyze
      - artifact.publish

管理后台负责查看、启停和审计，不在 MVP 中实现可视化编排。

## 9.3 Workspace、Session 与 Run

Workspace 模块：

- 成员；
- 项目文件；
- 项目指令；
- Session；
- Artifact；
- 共享权限。

Session 模块：

- 连续对话；
- 消息；
- 上下文摘要；
- Session 级设置；
- 多个 Run 的关联。

Run 模块：

- 状态机；
- 排队；
- Agent Version 锁定；
- Attempt；
- 取消、重试和超时；
- 审批；
- 用量；
- 结果和错误。

MVP 和生产阶段三者均属于同一个 dsh-work 应用，但数据表、对象和模块接口必须分开。

## 9.4 Model Gateway 模块

MVP 即使只使用一个模型，也必须通过稳定接口调用。

职责：

- 模型配置和凭证隔离；
- 数据分级检查；
- 脱敏和字段过滤；
- 请求和流式响应适配；
- Tool Call 兼容；
- 超时、有限重试和错误转换；
- Token、延迟和成本记录；
- 禁止浏览器持有模型 API Key。

目标阶段增加：

- 多供应商路由；
- 内外部模型切换；
- 限流、熔断和降级；
- 部门配额；
- 敏感数据强制内部模型。

## 9.5 Connector Gateway 模块

Connector Gateway 是企业系统访问的唯一 Agent 入口，对 DSH 暴露类型化 Tool 接口。

职责：

- Tool Registry；
- 严格参数 Schema；
- Agent 权限；
- 员工权限；
- 业务数据范围；
- 字段白名单；
- 敏感字段屏蔽；
- 审批；
- 超时和有限重试；
- 幂等；
- 审计。

MVP 的 Connector Gateway 只运行实施团队预置的 3～5 个只读 Tool。Tool Schema、连接地址、认证方式和凭据引用通过服务端代码或受控配置交付，不在管理后台提供自助注册和编辑入口。管理后台可以查看 Tool/Connector 元数据、配置 Tool 权限与启停状态，并执行 Connector 健康检查。

禁止：

- Agent 生成任意 SQL 并直连 ERP；
- DSH 保存业务系统长期凭证；
- 仅依赖 Prompt 做权限控制；
- 由模型填写 user_id 或 department_id；
- 将完整 ERP 表直接发送给模型。

## 9.6 Artifact Service 模块

职责：

- 存储 PDF、DOCX、XLSX、图片和预览；
- 维护 Artifact 和版本；
- 记录 Workspace、Session、Run、Agent Version 和 Skill 关系；
- 下载权限；
- 文件保留和清理；
- 渲染、缩略图和预览；
- 发布新版本，不覆盖历史。

MVP 使用本地目录或 NAS：

    /data/
    ├─ uploads/{user_id}/{workspace_id}/
    ├─ workspaces/{workspace_id}/{run_id}/
    ├─ artifacts/{workspace_id}/{artifact_id}/
    ├─ runtime-logs/{run_id}/{attempt_id}/
    └─ backups/

后续通过 ArtifactStore 接口迁移到 MinIO 或其他对象存储，不改变业务对象。

## 9.7 审计与可观测

至少记录：

    user_id
    department_id
    workspace_id
    session_id
    run_id
    attempt_id
    agent_id
    agent_version_id
    skill_versions
    tool_name
    tool_arguments_summary
    business_object_ids
    tool_result_summary
    model_provider
    model_name
    token_usage
    artifact_ids
    start_time
    end_time
    status
    error_code
    trace_id

敏感字段只保存脱敏摘要或业务对象标识。

---

# 十、Skill、Tool 与成果生成

## 10.1 Skill 管理

Skill 负责业务方法，不直接持有企业系统凭证。

例如缺料分析 Skill 定义：

- 所需输入；
- 查询顺序；
- 库存口径；
- 在途采购判断；
- 安全库存规则；
- 风险等级；
- 输出格式；
- 禁止事项。

公共 Skill 必须：

- 版本化；
- 通过 Git 或发布流程评审；
- 发布后只读；
- 记录依赖；
- 每个 Run 记录具体版本；
- 禁止 Agent 自动修改生产 Skill。

## 10.2 首批企业 Tool

| Tool | 作用 | 权限范围 |
|---|---|---|
| knowledge.search | 检索制度和资料 | 按知识目录 |
| erp.get_sales_order | 查询销售订单 | 按负责人或部门 |
| mes.get_work_order_progress | 查询工单进度 | 按工厂 |
| wms.get_material_inventory | 查询库存 | 按仓库 |
| procurement.get_delivery_plan | 查询到货计划 | 按采购范围 |
| document.extract | 提取 DOCX、PDF 和文本结构 | 当前 Workspace 文件 |
| spreadsheet.analyze | 读取表格、计算指标和图表数据 | 当前 Workspace 文件 |
| report.create | 生成 DOCX 或 PDF 报告 | 当前 Run 输出 |
| artifact.publish | 发布 Artifact 版本 | 当前 Workspace |

## 10.3 Tool 基本契约

每个 Tool 必须有：

- 唯一名称和版本；
- 输入、输出 Schema；
- 风险等级；
- 允许的 Agent；
- 允许的角色和数据范围；
- 超时；
- 错误码；
- 幂等策略；
- 审批策略；
- 审计摘要策略；
- 敏感字段说明。

## 10.4 成果输出契约

每个生成类能力必须定义：

- 输出文件类型；
- 是否可编辑；
- 是否需要预览；
- 是否需要质量检查；
- 文件命名；
- 版本策略；
- 失败错误；
- 来源追溯；
- 人工终检要求。

---

# 十一、安全、权限与数据边界

## 11.1 三层权限

### 平台使用权限

判断员工是否可以登录和使用 dsh-work。

### 能力使用权限

判断员工可以使用哪些 Agent、Skill 和 Tool。

### 业务数据范围

判断员工可以查看哪些客户、订单、工厂、仓库和字段。

管理员不因平台管理角色自动获得全部业务数据权限。

## 11.2 数据分级与模型策略

| 数据级别 | 示例 | MVP 策略 |
|---|---|---|
| L0 公开 | 公开产品资料、通用办公内容 | 可使用经批准的外部模型 |
| L1 内部一般 | 内部制度、普通项目文件 | 经批准、最小化和脱敏后可使用外部模型 |
| L2 敏感 | ERP 经营数据、财务、人事、研发机密 | 原始明细不得进入外部模型；使用内部模型或排除该场景 |
| L3 受限操作 | 写 ERP、发邮件、覆盖文件 | MVP 禁止；后续需审批、幂等和完整审计 |

如果 MVP 暂无内部模型：

- Tool 只返回完成任务所需的最小字段；
- 优先返回聚合、标签或脱敏结果；
- L2 原始明细留在企业系统和 Tool 侧；
- 无法降敏的 L2 场景不进入试点；
- 页面明确提示数据处理边界。

## 11.3 模型 API Key

调用链：

    员工浏览器
        ↓
    dsh-work 后端
        ↓
    Model Gateway 模块
        ↓
    DSH Runtime 或模型 Provider
        ↓
    经批准的模型 API

API Key 不得进入：

- Vue 前端；
- LocalStorage；
- Git；
- Prompt；
- Skill 文档；
- 普通任务日志；
- Artifact 元数据。

## 11.4 文件安全

- 上传文件只读；
- 文件名由后端重新生成；
- 文件类型、大小和内容进行检查；
- Run 只能访问当前 Workspace 授权文件；
- Worker 输出只能写当前 Attempt 目录；
- 禁止覆盖原始文件；
- 下载必须校验权限；
- 设置保留期限；
- 临时目录按策略清理；
- 高敏文件明确禁止进入外部模型场景。

## 11.5 DSH 访问边界

- 生产环境员工不能访问 DSH Web UI；
- DSH 只监听 Loopback、容器内部或不开放网络端口；
- 仅 Runtime Adapter 可以控制 Worker；
- 调试 Web 只在隔离研发环境开放；
- 插件清单固定；
- 禁止运行时安装不受信任插件；
- 禁止共享一个长期高权限 Worker 服务多名员工。

## 11.6 网络边界

    公司内网

    员工电脑
        │ HTTPS 443
        ▼
    Mac mini / dsh-work
        ├─→ ERP / MES / 知识库
        └─→ 经批准的模型 API 域名

Mac mini 入站：

- 443：dsh-work HTTPS；
- 22：仅管理员网段，可选。

Mac mini 外连：

- 经批准的模型 API 域名；
- 必要 DNS 和时间同步；
- 经批准的软件更新地址；
- 企业内部系统。

必须关闭：

- Internet Sharing；
- IP Forwarding；
- 员工代理服务；
- 公网直接访问 dsh-work；
- 员工直接访问 DSH；
- 浏览器持有模型 Key。

## 11.7 高风险操作

MVP 不支持高风险写操作。

后续如引入写 ERP、发邮件、覆盖文件等能力，必须同时具备：

- Connector Gateway 审批；
- 用户二次确认；
- 业务权限复核；
- 幂等 Key；
- 事务或补偿方案；
- 完整审计；
- 明确的失败恢复。

---

# 十二、核心数据模型与接口

## 12.1 建议数据表

| 数据表 | 主要内容 |
|---|---|
| users | 员工身份、部门和状态 |
| roles | 角色 |
| user_roles | 用户角色 |
| data_scopes | 工厂、仓库、部门和业务范围 |
| agents | Agent 基本信息 |
| agent_versions | 不可变 Agent Version |
| skills | Skill 元数据和版本 |
| tools | Tool Schema、风险和策略 |
| workspaces | Workspace |
| workspace_members | 成员和角色 |
| files | 上传文件和来源 |
| sessions | 连续对话 |
| messages | 用户和助手消息 |
| runs | 一次用户任务 |
| runtime_attempts | 一次 Worker 尝试 |
| run_events | 产品层标准事件 |
| artifacts | Artifact 主体 |
| artifact_versions | 文件版本和来源 |
| tool_audit_logs | Tool 调用审计 |
| model_usage_records | 模型、Token、延迟和成本 |
| approvals | 审批请求和结果 |
| system_settings | 系统配置和功能开关 |

## 12.2 关键约束

- Session 和 DSH Session Log 不共用 ID；
- Run 创建时锁定 Agent Version；
- Attempt 必须属于唯一 Run；
- Artifact Version 必须能追溯到 Run；
- Tool 审计必须关联 user_id、run_id 和 tool_id；
- 敏感参数不保存完整明文；
- 产品状态不依赖 DSH 工作目录。

## 12.3 员工 API

    GET    /api/me
    GET    /api/workspaces
    POST   /api/workspaces
    GET    /api/workspaces/:workspaceId
    POST   /api/workspaces/:workspaceId/files
    GET    /api/sessions
    POST   /api/sessions
    GET    /api/sessions/:sessionId
    POST   /api/sessions/:sessionId/runs
    GET    /api/runs/:runId
    GET    /api/runs/:runId/events
    POST   /api/runs/:runId/cancel
    POST   /api/runs/:runId/retry
    GET    /api/artifacts/:artifactId
    GET    /api/artifacts/:artifactId/versions/:versionId/download

## 12.4 管理 API

    GET    /api/admin/users
    GET    /api/admin/agents
    GET    /api/admin/agent-versions
    POST   /api/admin/agent-versions/:id/publish
    POST   /api/admin/agent-versions/:id/disable
    GET    /api/admin/skills
    GET    /api/admin/tools
    PUT    /api/admin/tools/:id/permissions
    GET    /api/admin/audit
    GET    /api/admin/usage
    GET    /api/admin/health

## 12.5 内部接口

    ModelGateway.complete(request)
    ModelGateway.stream(request)

    ToolGateway.execute(toolId, trustedContext, businessArguments)

    ArtifactService.create(runId, metadata)
    ArtifactService.publishVersion(artifactId, file, provenance)
    ArtifactService.authorizeDownload(userId, versionId)

    RuntimeAdapter.execute(runManifest)
    RuntimeAdapter.subscribe(attemptId)
    RuntimeAdapter.cancel(attemptId)
    RuntimeAdapter.close(attemptId)

---

# 十三、MVP 范围与部署

## 13.1 MVP 必须实现

| 能力域 | MVP 内容 |
|---|---|
| 登录 | 企业 SSO 或内部账号 |
| 员工入口 | 一个 dsh-work Assistant |
| Workspace | 团队 Workspace、成员、共享文件、Session 和 Artifact |
| Session | 连续对话和历史消息 |
| Run | 状态、排队、取消、重试和超时 |
| Runtime | Runtime Adapter、Attempt、DSH Worker 和事件流 |
| Agent | 管理后台创建、测试和发布；一个正式启用的 Agent Version，本地 GovernancePort 与 PostgreSQL 管理 |
| Model | 一个经批准的模型 Provider，通过 Model Gateway 模块 |
| Tool | 预置 Tool Registry 和 Connector Gateway 模块；3～5 个只读业务 Tool |
| 知识 | 一个企业知识查询 Tool |
| ERP/MES | 3～5 个只读业务 Tool |
| 文件 | Excel、CSV、PDF、Word 基础分析 |
| Artifact | Markdown、XLSX、DOCX 或 PDF；版本和下载 |
| 权限 | 用户、角色、Agent、Tool 和数据范围 |
| 审计 | Run、Attempt、模型、Tool 和 Artifact |
| 部署 | Mac mini 内网部署 |
| 备份 | PostgreSQL 和成果文件备份 |

## 13.2 MVP 暂不建设

- PPT 或其他演示文稿生成；
- 多 Agent 市场；
- 可视化 Agent Builder；
- 员工自由安装插件或 MCP；
- 管理后台自定义 Tool 注册和 Schema 在线编辑；
- 管理后台自助接入或编辑 API、MCP Server、数据库等 Connector；
- 业务微服务；
- Redis 和 MQ；
- Kubernetes；
- MinIO；
- Vault；
- 桌面客户端；
- 本地 Runtime；
- 长期个人记忆；
- 部门共享 Workspace 的复杂协作；
- 定时任务；
- 跨天自主任务；
- ERP 正式写入；
- 任意 Shell 和 SQL。

## 13.3 试点容量假设

    注册员工：20～50 人
    日活员工：5～20 人
    同时运行 Run：3～5 个
    每日 Run：50～200 个
    单文件上传：不超过 20 MB
    单 Run 文件总量：不超过 50 MB
    默认活跃任务上限：4
    默认排队任务上限：50
    Worker 空闲时间：15 分钟以内

正式容量以真实文件大小、Tool 响应时间、模型延迟和任务复杂度压测为准。

## 13.4 Mac mini 基线

建议起步配置：

    Apple Silicon Mac mini
    内存：32 GB
    存储：1 TB SSD
    网络：千兆有线
    备份：企业 NAS 或独立备份设备

建议进程或容器：

    reverse-proxy
    dsh-work-app
    postgres
    dsh-worker 子进程

## 13.5 运行要求

- 固定内网 IP；
- HTTPS；
- 禁止自动休眠；
- 使用 launchd 或容器自启动；
- 配置 UPS；
- PostgreSQL 每日备份；
- Artifact 定期归档；
- 定期执行恢复演练；
- API Key 不进入代码仓库；
- 固定 dsh-work 和 DSH 版本；
- 健康检查；
- 磁盘、内存、队列和任务失败告警；
- 临时文件清理；
- 管理操作审计。

---

# 十四、验收指标

## 14.1 产品指标

| 指标 | MVP 目标 |
|---|---:|
| 三类核心场景端到端可用 | 3 类全部完成 |
| 员工任务完成率 | ≥ 80% |
| 知识和文档类 Run 完成率 | POC 校准后目标 ≥ 90% |
| 文件成果生成成功率 | ≥ 90% |
| 有引用的知识回答比例 | ≥ 90% |
| 重复使用率 | 试点期持续上升 |
| 人工整理时间 | 相比原流程明显下降 |

## 14.2 技术指标

| 指标 | MVP 目标 |
|---|---:|
| Tool 调用成功率 | ≥ 95% |
| Run 状态可追踪率 | 100% |
| Run、Attempt、Tool、Artifact 关联完整率 | 100% |
| Artifact 下载权限校验率 | 100% |
| Worker 失败可明确标记并重试 | 100% |
| 数据库和文件恢复演练 | 通过 |
| 模型 API Key 前端暴露 | 0 |
| dsh-work 业务微服务拆分 | 0；保持一个模块化单体业务部署单元 |
| 模块独立数据库和分布式事务 | 0 |

## 14.3 安全指标

| 指标 | MVP 目标 |
|---|---:|
| 越权调用成功次数 | 0 |
| 跨 Workspace 文件泄露 | 0 |
| 跨用户 Worker 上下文串用 | 0 |
| 未审批 L2 数据进入外部模型 | 0 |
| 未注册 Tool 调用 | 0 |
| 任意 Shell 或 SQL 能力暴露 | 0 |

# 十五、实施阶段

本章定义阶段目标和退出条件；具体任务、依赖、主责、工作量、排期、测试和发布步骤以[《dsh-work MVP 实施方案与计划》](dsh-work%20MVP%20实施方案与计划.md)为执行基线。

## 15.1 阶段 0：技术可行性验证

目标：

- 验证 DSH、Runtime Adapter、Tool 调用和文件处理的技术可行性。

交付：

- 固定 DSH 版本；
- Headless Worker 冒烟测试；
- Runtime Adapter POC；
- 标准 Runtime Manifest；
- 标准 Run Event；
- 取消、超时和资源回收；
- 一个模拟 Tool；
- 一个真实只读 Tool；
- 模型数据边界验证；
- Mac mini 资源基线。

退出条件：

- 浏览器可提交任务；
- Run 可排队、执行、取消并返回结果；
- DSH 可调用模型和受控 Tool；
- Run、Attempt 和事件可追踪；
- 明确是否需要最小 DSH Fork；
- 形成性能、成本和安全基线。

## 15.2 阶段 1：dsh-work MVP

目标：

- 形成员工可使用的内网 AI 工作台。

交付：

- 登录；
- 一个 dsh-work Assistant；
- Workspace、Session 和 Run；
- 文件上传；
- 知识查询；
- 实施团队预置的 ERP/MES 只读 Tool；
- 文件分析和报告；
- Artifact 版本和下载；
- Model、Tool、Artifact 逻辑边界；
- 权限和审计；
- Mac mini 正式部署；
- 备份和恢复流程。

退出条件：

- 三类核心场景端到端完成；
- 20～50 名试点员工可稳定使用；
- 核心安全指标通过；
- Artifact 可追溯；
- 无必须依赖人工后台修复的常见任务。

## 15.3 阶段 2：部门试点

目标：

- 验证真实业务价值、效果、安全和容量。

交付：

- 选择一个业务部门；
- 导入真实用户和数据范围；
- 发布真实 Skill；
- 接入真实 Tool；
- 采集使用、成本和失败数据；
- 优化 Tool Schema、Prompt 和模型策略；
- 建立运营和反馈流程；
- 完善监控、告警和恢复。

退出条件：

- 任务完成率和重复使用率达到内部目标；
- 无越权和数据出口事故；
- 明确最有价值的 Agent 和 Tool；
- 明确是否需要企业已有模型网关、外部队列、共享存储或多主机 Worker；
- 形成下一阶段投资决策。

## 15.4 阶段 3：企业平台化

按试点结果选择性增加：

- 多 Agent 目录；
- Agent Builder；
- Skill 和 Tool 发布中心；
- 按门槛接入 AI Hub 治理控制面；
- 多部门 Workspace 与统一配额；
- 多个相同的 `dsh-work-app` 实例；
- Redis/MQ 或其他共享队列基础设施；
- NAS、MinIO 或其他对象存储；
- Vault/KMS 与 OpenTelemetry；
- 多主机 DSH Worker 进程池；
- Linux 生产服务器；
- Kubernetes 或其他容器平台（可选）；
- 审批和高风险写操作；
- 桌面端和本地 Runtime。

原则：

> 企业平台化继续采用模块化单体，不以服务数量衡量成熟度。网络区隔或重计算场景可以增加无业务状态的代理或 Worker 进程，但不拆分业务领域、独立数据库或分布式事务。

## 15.5 团队职责

| 角色 | 主要职责 |
|---|---|
| 产品负责人 | 范围、场景、验收和试点运营 |
| 平台后端 | 身份、Agent、Workspace、Session、Run、网关和 Artifact |
| Runtime 工程师 | DSH Adapter、事件、取消、恢复和隔离 |
| 前端工程师 | 工作台、管理后台、Run 状态和成果体验 |
| AI/Agent 工程师 | Prompt、Skill、Tool Schema 和效果评测 |
| 业务专家 | 业务口径、规则、样例和验收 |
| 运维安全 | 网络、Secret、审计、备份、监控和应急 |

---

# 十六、主要风险与治理

| 风险 | 影响 | 治理措施 |
|---|---|---|
| DSH 版本变化 | API 或插件变化影响平台 | 固定版本、Adapter、契约测试、升级沙箱和回滚 |
| MVP 过度建设 | 周期变长、价值验证延后 | 模块化单体、最小依赖、阶段退出条件 |
| MVP 边界过弱 | 后续重构产品对象 | 从第一天采用 Workspace、Session、Run、Attempt 和 Artifact |
| Mac mini 单点 | 服务中断和数据风险 | UPS、自启动、NAS 备份、恢复脚本和迁移预案 |
| 多用户上下文串用 | 数据泄露 | 一 Run 一 Worker、独立目录、最小凭证和审计 |
| Prompt Injection | 文档诱导高风险 Tool | Tool Allowlist、Schema、业务权限、输入隔离和审批 |
| 外部模型数据泄露 | 内部资料外发 | 数据分级、字段最小化、脱敏、域名白名单和审计 |
| 模型幻觉 | 编造企业事实 | 业务事实来自 Tool；展示来源和时间 |
| Tool 误调用 | 越权或错误查询 | 后端身份、三层权限、参数校验和业务对象范围 |
| ERP 接口不稳定 | 任务失败 | 超时、错误转换、有限重试和明确失败提示 |
| 文件处理占用资源 | 单机拥堵 | 文件大小、并发、超时和临时文件清理 |
| 模型成本失控 | 费用超预算 | Token 和 Step 上限、任务超时、用量统计和配额 |
| Skill 漂移 | 同类任务结果不一致 | 固定版本、评审发布、不可变 Run 依赖 |
| Artifact 丢失或覆盖 | 无法追溯 | 不可变版本、备份、权限和恢复演练 |
| 平台耦合 DSH | 难以升级或替换 | Runtime Manifest、标准 Run Event 和 Adapter |

---

# 十七、最终产品与架构决策

dsh-work 当前阶段采用以下统一决策：

    项目名称：
    dsh-work

    产品名称：
    dsh-work

    产品定位：
    企业 AI Agent 工作台

    员工入口：
    自研内网 Web

    首期 Agent：
    一个统一 dsh-work Assistant

    产品领域模型：
    User / Agent / Agent Version / Workspace / Session
    Run / Runtime Attempt / Artifact

    Agent Runtime：
    固定版本 DeepSeek Harness，通过 Runtime Adapter 隔离

    应用架构：
    Vue + Node.js + PostgreSQL 长期模块化单体

    生产部署：
    可部署多个相同的 dsh-work-app 实例
    DSH Worker 使用独立进程或多主机进程池
    Linux、虚拟机或容器均可，Kubernetes 非必需

    微服务决策：
    不采用业务微服务
    Model Gateway、Connector Gateway、Artifact Service 保持应用内逻辑模块
    网络隔离代理和 Worker 进程不拥有独立业务模型或数据库

    首期部署：
    公司内网 Mac mini

    运行边界：
    默认一 Run 一 Worker；一次失败重试产生新 Attempt

    模型方式：
    一个经批准的模型 Provider
    所有调用经过 Model Gateway 接口和数据分级策略

    企业系统连接：
    类型化只读 Tool
    所有调用经过 Connector Gateway 模块和服务端权限

    文件和成果：
    Artifact Service 逻辑边界
    本地目录或 NAS 存储适配器
    新版本不覆盖历史

    安全策略：
    后端可信身份、最小权限、只读优先
    Tool Allowlist、数据范围、模型数据分级
    关闭任意 Shell、SQL 和动态插件

    MVP 核心场景：
    企业知识查询
    ERP/MES 只读业务查询
    文件分析与报告生成

一句话概括：

> dsh-work 是部署在企业内网的统一 AI Agent 工作台，由自研模块化单体管理员工、Workspace、Session、Run、权限、文件、成果和审计，DSH 作为可替换的独立执行进程；MVP 与生产阶段均保持 Runtime Adapter、Model Gateway、Connector Gateway 和 Artifact Service 的稳定逻辑边界，但不把这些边界等同于微服务边界。

---

# 十八、待评审参数

以下事项不改变总体架构，但必须在阶段 0 或 MVP 启动前确认：

| 参数 | 需要确认的内容 |
|---|---|
| 试点部门 | 首批 20～50 人来自哪个部门 |
| 业务场景 | 三类场景中的首要价值锚点 |
| 模型 Provider | 模型、区域、数据条款、出口和成本 |
| L2 数据策略 | 是否具备内部模型；哪些 ERP 字段可以降敏 |
| 企业身份 | SSO、LDAP、钉钉或内部账号 |
| 首批 Tool | 3～5 个真实只读接口及 Owner |
| 知识来源 | 现有知识库接口、文档目录和版本口径 |
| 文件策略 | 允许类型、大小、保留期限和高敏文件规则 |
| Artifact 备份 | NAS 路径、频率、恢复 RTO 和 RPO |
| 服务目标 | 试点服务时间、维护窗口和告警责任人 |

---

# 附录 A：建议技术栈

| 模块 | MVP 建议 |
|---|---|
| 员工 Web / 管理后台 | 两个独立 Vue 3 + TypeScript + Vite 应用；共享 Element Plus、Design Token 与基础组件包 |
| 流式状态 | SSE；确有双向需求时再使用 WebSocket |
| 平台服务 | Node.js + TypeScript，Express 或 Fastify |
| 应用形态 | 长期模块化单体；生产环境可部署多个相同实例 |
| 数据库 | PostgreSQL |
| ORM | Prisma 或等价方案 |
| Runtime | 固定版本 DSH + Runtime Adapter |
| 文件存储 | 本地持久化目录或 NAS |
| 反向代理 | Caddy 或 Nginx |
| 日志与指标 | 结构化日志、基础指标和数据库审计 |
| 后续扩展 | 按需增加 Redis/MQ、对象存储、Vault/KMS、OpenTelemetry；Kubernetes 可选 |

---

# 附录 B：建议代码边界

    dsh-work/
    ├─ apps/
    │  ├─ workbench-web/
    │  └─ admin-web/
    ├─ packages/
    │  ├─ design-tokens/
    │  ├─ ui-core/
    │  ├─ workbench-components/
    │  └─ admin-components/
    ├─ server/
    │  ├─ identity/
    │  ├─ agents/
    │  ├─ skills/
    │  ├─ tool-registry/
    │  ├─ workspaces/
    │  ├─ sessions/
    │  ├─ runs/
    │  ├─ model-gateway/
    │  ├─ tool-gateway/
    │  ├─ artifacts/
    │  ├─ audit/
    │  └─ admin/
    ├─ runtime-adapters/
    │  └─ dsh-adapter/
    ├─ config/
    │  ├─ agents/
    │  ├─ skills/
    │  ├─ tools/
    │  └─ policies/
    ├─ runtime-workspaces/
    ├─ tests/
    │  ├─ contracts/
    │  ├─ security/
    │  ├─ integration/
    │  └─ evals/
    └─ deploy/
       └─ mac-mini/

代码长期保存在一个仓库中。员工工作台与管理后台独立构建、独立发布静态资源，并复用共享前端包；Node.js 后端仍保持一个模块化单体业务部署单元，生产环境可以运行多个相同实例；DSH Worker 作为独立执行进程。前端构建边界和后端逻辑模块均不得被默认解释为业务微服务。

---

# 附录 C：关键禁止事项

- 员工直接访问 DSH Web UI；
- 业务数据库采用 DSH 内部 Session 或 Preset 结构；
- 为每个业务 Agent 创建长期 DSH Profile；
- DSH 直接连接 ERP 数据库；
- DSH 保存业务系统长期凭证；
- 模型决定当前用户身份；
- 一个高权限 Worker 混跑多个用户；
- 将生成的报告、表格等成果仅作为 Runtime 临时文件；
- 员工安装任意插件或 MCP；
- 生产环境开放任意 Shell 或 SQL；
- 将模型 API Key 暴露给浏览器；
- 将 Mac mini 作为员工上网代理；
- 未经数据分级就把企业明细发送给外部模型；
- 覆盖已发布 Artifact 历史版本。

---

# 附录 D：版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| V1.0 | 2026-08-25 | dsh-work 产品设计方案首次发布 |
| V1.1 | 2026-08-27 | 前端技术栈调整为 Vue，收敛一期成果生成范围，并补充简化架构方案 |
| V1.2 | 2026-08-28 | 明确长期采用模块化单体和独立 DSH Worker，不采用业务微服务，并校正生产架构与平台化阶段 |
| V1.3 | 2026-08-28 | 固化员工工作台、管理后台和四个共享前端包的最终目录；明确两个前端独立构建、后端继续采用模块化单体 |
| V1.4 | 2026-08-29 | 收敛一期 Tool/Connector 范围：仅支持实施团队预置能力，管理后台不开放自定义工具注册或连接器接入与编辑 |
| V1.5 | 2026-08-29 | 标记前端原型已确认，校正团队工作空间与对话信息架构，并引用独立 MVP 实施方案与计划 |
