import { backgroundLaneMaxConcurrent } from '../../domain/background-lanes.ts'
import type { PlatformSettingView } from '../../domain/platform-settings.ts'
import { MAX_SKILL_UPLOAD_BYTES } from '../../domain/skill-package-limits.ts'
import { defaultAutomationConfig } from '../automation/automation-types.ts'
import { maxKnowledgeUploadBytes } from '../knowledge/knowledge-base-service.ts'
import { uploadTimeoutMs, weknoraSearchTimeoutMs } from '../knowledge/weknora-client.ts'
import { DEFAULT_HEADERS_TIMEOUT_MS } from '../model-gateway/model-gateway.ts'
import { MODEL_ROUTE_RETRY_POLICY } from '../runtime/dsh-attempt-patch.ts'
import { DEFAULT_SETUP_TIMEOUT_MS } from '../runtime/dsh-acp-runtime-adapter.ts'
import { EXECUTION_CONTAINER_LIMITS, PYTHON_SANDBOX_LIMITS } from '../runtime/execution-backend.ts'
import { PYTHON_CALL_TIMEOUT_MS } from '../runtime/execution-container-python.ts'
import { platformToolContracts } from '../runtime/platform-tool-contracts.ts'
import { WORKSPACE_LIMITS } from '../runtime/workspace-usage.ts'
import { ARTIFACT_LIMITS } from '../workbench/application/artifact-file-policy.ts'

/** 参数来源（运行参数配置方案 6.4）：页面配置 / 默认值 / 环境变量 / 系统内置 / 部署脚本。 */
export type RuntimeParameterSource = 'page' | 'default' | 'env' | 'builtin' | 'deploy'

/** 谁能修改：平台管理员，或某个模块的修改权限；`null` 为不可修改。 */
export type RuntimeParameterOwner = { kind: 'platform-admin' } | { kind: 'module'; module: 'agent' | 'config' | 'dingtalk' | 'knowledge' } | null

export interface RuntimeParameterEntry {
  id: string
  /** `config`：平台配置页修改；`other`：留在原页面（Agent 运行限制与凭据）；`run`、`identity`：暂不可修改；`fixed`：只读。 */
  group: 'config' | 'run' | 'identity' | 'other' | 'fixed'
  name: string
  value: string
  source: RuntimeParameterSource
  timing: string
  /** 修改位置；不可修改时为原因说明。 */
  where: string
  /** 管理端页面路径；不可修改时省略。 */
  link?: string
  owner: RuntimeParameterOwner
  /** 当前管理员能否修改（按 owner 判定）。 */
  canEdit: boolean
}

export interface TimeoutChain {
  id: string
  name: string
  actual: string
  limiter: string
  layers: string[]
  warning?: string
}

export interface RuntimeParametersOverview {
  entries: RuntimeParameterEntry[]
  timeoutChains: TimeoutChain[]
}

export interface RuntimeSummary {
  id: string
  name: string
  capacity: number
  timeoutSeconds: number
  /** 是否在 Runtimes 页保存过配置；没有时容量来自初始数据、超时为默认 300 秒。 */
  configured: boolean
  /** 运行超时大于本 Runtime 单次执行超时的已发布 Agent 数。 */
  agentsOverTimeout: number
}

export interface DingTalkSummary {
  source: 'deployment-config' | 'admin'
  sessionTtlSeconds: number
  bindingTicketTtlSeconds: number
  adminDailyBindLimit: number
  timeoutMs: number
}

export interface RuntimeParametersOverviewInput {
  settings: PlatformSettingView[]
  runtimes: RuntimeSummary[]
  sessionTtl: { seconds: number; fromEnvironment: boolean }
  canEdit(owner: NonNullable<RuntimeParameterOwner>): boolean
}

const ADMIN_ASSISTANT_TIMEOUT_SECONDS = 180
const BACKGROUND_SUMMARY_TIMEOUT_SECONDS = 120
/** DSH `execution-container.cordis.patch.yml` 中 bash 的默认超时。 */
const BASH_DEFAULT_TIMEOUT_SECONDS = 60
/** 成果文本解析（`main.ts` 中独立的 2 个槽位，`container-artifact-text-extractor.ts` 默认 60 秒）。 */
const EXTRACTION_TIMEOUT_SECONDS = 60
const EXTRACTION_SLOTS = 2
const DATABASE_POOL_SIZE = 10

export function formatDuration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

function formatMegabytes(bytes: number) {
  return bytes >= 1024 ** 3 ? `${bytes / 1024 ** 3} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

function formatSettingValue(setting: PlatformSettingView) {
  return setting.unit === '%' ? `${setting.value}%` : `${setting.value} ${setting.unit}`
}

/** 主 Runtime：调度中的第一个（按 id），用于超时链路。 */
function primaryRuntime(runtimes: RuntimeSummary[]) {
  return runtimes[0]
}

export function buildRuntimeParametersOverview(input: RuntimeParametersOverviewInput): RuntimeParametersOverview {
  const entries: RuntimeParameterEntry[] = []
  const add = (entry: Omit<RuntimeParameterEntry, 'canEdit'>) =>
    entries.push({ ...entry, canEdit: entry.owner ? input.canEdit(entry.owner) : false })
  const platformAdmin = { kind: 'platform-admin' } as const

  for (const setting of input.settings) {
    const owner: NonNullable<RuntimeParameterOwner> = setting.savePermission === 'platform-admin' ? platformAdmin : { kind: 'module', module: 'config' }
    entries.push({
      id: setting.key, group: 'config', name: setting.label, value: formatSettingValue(setting),
      source: setting.source, timing: setting.timing, where: '平台配置 · 配置', link: '/platform-config', owner,
      canEdit: setting.available && input.canEdit(owner),
    })
  }

  add({
    id: 'agent.limits', group: 'other', name: 'Agent 运行超时 / 工具调用 / 输出', value: '按 Agent 设置',
    source: 'page', timing: '发布后的下次运行', where: 'Agent 管理', link: '/agents', owner: { kind: 'module', module: 'agent' },
  })
  add({
    id: 'dingtalk.application', group: 'other', name: '钉钉 CorpId / AppKey / AppSecret', value: '在钉钉集成页查看',
    source: 'page', timing: '立即', where: '钉钉集成 · 应用配置', link: '/dingtalk', owner: platformAdmin,
  })
  add({
    id: 'knowledge.connection', group: 'other', name: '知识库连接地址 / 密钥 / 嵌入模型', value: '在企业知识库页查看',
    source: 'page', timing: '立即', where: '企业知识库 · 连接配置', link: '/knowledge', owner: { kind: 'module', module: 'knowledge' },
  })
  add({
    id: 'model.headers_timeout', group: 'run', name: '模型首个响应超时', value: formatDuration(DEFAULT_HEADERS_TIMEOUT_MS / 1000),
    source: 'builtin', timing: '—', where: '暂不可修改', owner: null,
  })
  add({
    id: 'knowledge.timeouts', group: 'run', name: '知识库检索超时 / 上传与下载超时',
    value: `${formatDuration(weknoraSearchTimeoutMs / 1000)} / ${formatDuration(uploadTimeoutMs / 1000)}`,
    source: 'builtin', timing: '—', where: '暂不可修改', owner: null,
  })
  add({
    id: 'identity.session_ttl', group: 'identity', name: '登录会话有效期', value: formatDuration(input.sessionTtl.seconds),
    source: input.sessionTtl.fromEnvironment ? 'env' : 'default', timing: '重启后的新登录', where: '改环境变量后重启', owner: null,
  })

  const toolTimeouts = Object.values(platformToolContracts).map(contract => contract.timeoutMs / 1000)
  const fixed: Array<[string, string, string, RuntimeParameterSource, string, string]> = [
    ['fixed.execution_container', '执行容器资源', `${EXECUTION_CONTAINER_LIMITS.memory.toUpperCase()}B · ${EXECUTION_CONTAINER_LIMITS.cpus} 核 · ${EXECUTION_CONTAINER_LIMITS.pidsLimit} 进程`, 'builtin', '—', '不可修改（安全隔离）'],
    ['fixed.commands', '单条命令最长 / bash 默认 / Python 调用', `${EXECUTION_CONTAINER_LIMITS.maxCommandMs / 1000} / ${BASH_DEFAULT_TIMEOUT_SECONDS} / ${PYTHON_CALL_TIMEOUT_MS / 1000} 秒`, 'builtin', '—', '不可修改（Python 在执行容器内运行）'],
    ['fixed.extraction', '成果解析沙箱', `${PYTHON_SANDBOX_LIMITS.memory.toUpperCase()}B · ${PYTHON_SANDBOX_LIMITS.cpus} 核 · ${EXTRACTION_TIMEOUT_SECONDS} 秒 · 并发 ${EXTRACTION_SLOTS}`, 'builtin', '—', '不可修改（安全隔离）'],
    ['fixed.worker_setup', 'Worker 启动超时', formatDuration(DEFAULT_SETUP_TIMEOUT_MS / 1000), 'builtin', '—', '不可修改'],
    ['fixed.workspace', '工作区上限', `${formatMegabytes(WORKSPACE_LIMITS.maxBytes)} · ${WORKSPACE_LIMITS.maxEntries / 10_000} 万文件 · 超过 ${formatMegabytes(WORKSPACE_LIMITS.failBytes)} 判失败`, 'builtin', '—', '不可修改'],
    ['fixed.sizes', '大小上限', `产物 ${formatMegabytes(ARTIFACT_LIMITS.maxFileBytes)} / 合计 ${formatMegabytes(ARTIFACT_LIMITS.maxTotalBytes)} / ${ARTIFACT_LIMITS.maxFiles} 个 · 知识库文档 ${formatMegabytes(maxKnowledgeUploadBytes)} · Skill 包 ${formatMegabytes(MAX_SKILL_UPLOAD_BYTES)}`, 'builtin', '—', '不可修改（前后端共用）'],
    ['fixed.model_retry', '模型请求重试', `最多 ${MODEL_ROUTE_RETRY_POLICY.maxRetries} 次`, 'builtin', '—', '不可修改（与 DSH 耦合）'],
    ['fixed.tool_timeouts', '平台工具超时', `${Math.min(...toolTimeouts)}～${Math.max(...toolTimeouts)} 秒`, 'builtin', '—', '不可修改（工具契约）'],
    ['fixed.background_lanes', '后台车道并发', `发布试运行 ${backgroundLaneMaxConcurrent['agent-release-trial']} · 项目档案员 ${backgroundLaneMaxConcurrent['project-archive']} · 会话摘要 ${backgroundLaneMaxConcurrent['session-summary']}`, 'builtin', '—', '不可修改'],
    ['fixed.automation_pending', '自动任务待执行上限', `每人 ${defaultAutomationConfig.userPendingLimit} · 全局 ${defaultAutomationConfig.globalPendingLimit}`, 'builtin', '—', '不可修改'],
    ['fixed.database_pool', '数据库连接池', String(DATABASE_POOL_SIZE), 'builtin', '—', '不可修改'],
    ['fixed.password_hash', '密码计算并发', '默认 min(4, CPU 核数)，至少 2', 'env', '重启后', '改环境变量后重启'],
    ['fixed.release_poll', '发布检查间隔', '300 秒', 'deploy', '重跑安装脚本后', '改部署变量后重跑安装脚本'],
  ]
  for (const [id, name, value, source, timing, where] of fixed) add({ id, group: 'fixed', name, value, source, timing, where, owner: null })

  return { entries, timeoutChains: timeoutChains(input) }
}

function timeoutChains(input: RuntimeParametersOverviewInput): TimeoutChain[] {
  const runtime = primaryRuntime(input.runtimes)
  const chains: TimeoutChain[] = []
  if (runtime) {
    const runtimeLimit = formatDuration(runtime.timeoutSeconds)
    const runtimeLayer = `Runtime“${runtime.name}”单次执行超时 ${runtimeLimit}`
    chains.push({
      id: 'conversation', name: '员工对话', actual: `≤ ${runtimeLimit}`, limiter: 'Runtime 单次执行超时',
      layers: ['按 Agent 设置（30～600 秒）', runtimeLayer],
      ...(runtime.agentsOverTimeout > 0
        ? { warning: `${runtime.agentsOverTimeout} 个已发布 Agent 的运行超时大于 ${runtimeLimit}，实际按 ${runtimeLimit} 执行` }
        : {}),
    })
    chains.push({
      id: 'automation', name: '自动任务与主动任务', actual: `≤ ${runtimeLimit}`, limiter: 'Runtime 单次执行超时',
      layers: ['取 Agent 超时、任务预算与 Runtime 超时的最小值', runtimeLayer],
    })
    const assistant = Math.min(ADMIN_ASSISTANT_TIMEOUT_SECONDS, runtime.timeoutSeconds)
    chains.push({
      id: 'admin-assistant', name: '管理助手', actual: formatDuration(assistant),
      limiter: assistant < ADMIN_ASSISTANT_TIMEOUT_SECONDS ? 'Runtime 单次执行超时' : `内置上限 ${ADMIN_ASSISTANT_TIMEOUT_SECONDS} 秒`,
      layers: [`内置 ${ADMIN_ASSISTANT_TIMEOUT_SECONDS} 秒`, runtimeLayer],
    })
    const background = Math.min(BACKGROUND_SUMMARY_TIMEOUT_SECONDS, runtime.timeoutSeconds)
    chains.push({
      id: 'background', name: '会话摘要 / 项目档案员', actual: formatDuration(background),
      limiter: background < BACKGROUND_SUMMARY_TIMEOUT_SECONDS ? 'Runtime 单次执行超时' : `内置上限 ${BACKGROUND_SUMMARY_TIMEOUT_SECONDS} 秒`,
      layers: [`内置 ${BACKGROUND_SUMMARY_TIMEOUT_SECONDS} 秒`, runtimeLayer],
    })
  }
  const headers = DEFAULT_HEADERS_TIMEOUT_MS / 1000
  chains.push({
    id: 'model', name: '模型请求', actual: formatDuration(headers), limiter: '首个响应超时',
    layers: [`每次最多等 ${formatDuration(headers)}`, `最多重试 ${MODEL_ROUTE_RETRY_POLICY.maxRetries} 次，仍受运行超时截断`],
  })
  const search = weknoraSearchTimeoutMs / 1000
  const tool = platformToolContracts.knowledge_search.timeoutMs / 1000
  const total = Math.min(search * 2, tool)
  chains.push({
    id: 'knowledge', name: '知识库检索', actual: formatDuration(total),
    limiter: search * 2 <= tool ? '检索超时 × 2 个请求' : '知识检索工具上限',
    layers: [`检索 ${search} 秒 × 2 个串行请求`, `知识检索工具上限 ${tool} 秒`],
  })
  return chains
}
