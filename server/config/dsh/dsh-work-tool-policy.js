import process from 'node:process'
import { appendFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const pathArguments = new Map([
  ['read', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
])

/**
 * Apply the immutable Runtime Manifest tool allow-list before DSH executes a tool.
 * Missing or malformed policy data intentionally produces an empty allow-list.
 */
export function apply(ctx) {
  const allowedTools = parseAllowedTools(process.env.DSH_ALLOWED_TOOLS_JSON)
  const workspaceRoot = parseWorkspaceRoot(process.env.DSH_WORKSPACE_ROOT)
  const approvalMode = parseApprovalMode(process.env.DSH_TOOL_APPROVAL_MODE)
  const approvalLog = parseApprovalLog(process.env.DSH_TOOL_APPROVAL_LOG)

  const denialReason = execution => validateExecution(execution, allowedTools, workspaceRoot)

  ctx.on('tools/pre-execute', async (execution, next) => {
    const denial = denialReason(execution)
    if (denial !== undefined) return { kind: 'deny', reason: denial }

    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    const requiresApproval = downstream.kind === 'ask' || approvalMode !== 'never'
    if (!requiresApproval) return downstream
    if (!recordApprovalRequest(approvalLog, execution)) {
      return { kind: 'deny', reason: 'dsh-work 无法记录工具审批关联，已拒绝执行' }
    }
    if (downstream.kind === 'ask') return downstream
    return {
      kind: 'ask',
      reason: approvalMode === 'always'
        ? `dsh-work 要求每次确认工具：${execution.name}`
        : `dsh-work 要求确认敏感工具：${execution.name}`,
    }
  })

  ctx.tools.guard((execution) => {
    return denialReason(execution)
  })
}

apply.inject = ['tools']
export default apply

function parseAllowedTools(value) {
  if (!value) return new Set()
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim())) {
      return new Set()
    }
    return new Set(parsed.map(item => item.trim()))
  } catch {
    return new Set()
  }
}

function parseWorkspaceRoot(value) {
  if (!value || !isAbsolute(value)) return undefined
  try {
    return realpathSync(value)
  } catch {
    return undefined
  }
}

function parseApprovalMode(value) {
  return value === 'never' || value === 'risk_based' || value === 'always' ? value : 'always'
}

function parseApprovalLog(value) {
  return value && isAbsolute(value) ? resolve(value) : undefined
}

function recordApprovalRequest(path, execution) {
  if (path === undefined || typeof execution.callId !== 'string' || execution.callId.length === 0) return false
  try {
    appendFileSync(path, `${JSON.stringify({ call_id: execution.callId, tool_name: execution.name })}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

function validateExecution(execution, allowedTools, workspaceRoot) {
  if (!allowedTools.has(execution.name)) {
    return `dsh-work Runtime Manifest 未授权工具：${execution.name}`
  }

  const argumentName = pathArguments.get(execution.name)
  if (argumentName === undefined) return undefined
  if (workspaceRoot === undefined) return 'dsh-work 当前 Run 工作区不可用，文件工具已拒绝执行'

  const argumentsRecord = isRecord(execution.arguments) ? execution.arguments : {}
  const rawPath = argumentsRecord[argumentName]
  if (rawPath === undefined && argumentName === 'path') return undefined
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return `dsh-work 文件工具参数无效：${argumentName}`
  }

  const candidate = resolve(workspaceRoot, rawPath)
  if (!isWithin(workspaceRoot, candidate)) return `dsh-work 拒绝访问当前 Run 工作区之外的路径：${rawPath}`

  try {
    const canonicalCandidate = realpathWithMissingTail(candidate)
    if (!isWithin(workspaceRoot, canonicalCandidate)) {
      return `dsh-work 拒绝通过符号链接访问当前 Run 工作区之外的路径：${rawPath}`
    }
  } catch {
    return `dsh-work 无法安全解析文件路径：${rawPath}`
  }
  return undefined
}

function realpathWithMissingTail(candidate) {
  let existing = candidate
  const missing = []
  while (true) {
    try {
      return resolve(realpathSync(existing), ...missing)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

function isMissingPathError(error) {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
