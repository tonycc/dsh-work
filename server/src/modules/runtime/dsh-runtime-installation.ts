import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

import { AcpJsonRpcClient } from './acp-json-rpc-client.ts'
import {
  createManagedDshAcpProcessConfiguration,
} from './dsh-acp-process-configuration.ts'
import type { AcpProcessConfiguration } from './acp-json-rpc-client.ts'

interface RuntimeLock {
  version: string
  commit: string
  protocolVersion: number
}

interface RuntimeMetadata extends RuntimeLock {
  name?: string
  acpConfig?: string
}

export interface DshRuntimeInstallation {
  home: string
  version: string
  commit: string
  protocolVersion: number
  launchMode: 'source-checkout' | 'managed-distribution'
  process: AcpProcessConfiguration
}

export interface ResolveDshRuntimeInstallationOptions {
  projectRoot: string
  env?: NodeJS.ProcessEnv
}

/** Resolve and verify the immutable DSH runtime selected for this deployment. */
export async function resolveDshRuntimeInstallation(
  options: ResolveDshRuntimeInstallationOptions,
): Promise<DshRuntimeInstallation> {
  const env = options.env ?? process.env
  const lock = await readJson<RuntimeLock>(resolve(
    options.projectRoot,
    'server/config/dsh/runtime-lock.json',
  ))
  assertRuntimeLock(lock)
  assertExpectedRuntimeLockEnvironment(env, lock)

  const home = resolve(env['DSH_RUNTIME_HOME'] ?? env['DSH_REPOSITORY'] ?? resolve(
    options.projectRoot,
    '../deepseek-harness',
  ))
  const configuredCommand = env['DSH_RUNTIME_COMMAND']
  const launchMode = configuredCommand ? 'managed-distribution' : 'source-checkout'

  await access(home, constants.R_OK)
  const metadata = launchMode === 'managed-distribution'
    ? await readJson<RuntimeMetadata>(resolve(home, 'dsh-runtime.json'))
    : await readSourceMetadata(home, lock.protocolVersion)

  if (metadata.version !== lock.version) {
    throw new Error(`DSH runtime version mismatch: expected ${lock.version}, received ${metadata.version}`)
  }
  if (metadata.commit !== lock.commit) {
    throw new Error(`DSH runtime commit mismatch: expected ${lock.commit}, received ${metadata.commit}`)
  }
  if (metadata.protocolVersion !== lock.protocolVersion) {
    throw new Error(`DSH ACP protocol mismatch: expected ${lock.protocolVersion}, received ${metadata.protocolVersion}`)
  }

  const deploymentConfigTemplate = resolve(
    options.projectRoot,
    'server/config/dsh/acp-managed-credentials.cordis.yml',
  )
  await access(deploymentConfigTemplate, constants.R_OK)
  const acpBaseConfig = resolve(home, metadata.acpConfig ?? 'examples/acp-agent/cordis.yml')
  await access(acpBaseConfig, constants.R_OK)
  const dataRoot = resolve(options.projectRoot, env['DSH_WORK_DATA_ROOT'] ?? '.runtime')
  const dshSessionsRoot = resolve(
    options.projectRoot,
    env['DSH_WORK_DSH_SESSIONS_ROOT'] ?? resolve(dataRoot, 'dsh-sessions'),
  )
  const deploymentConfig = await writeDeploymentOverlay(
    dataRoot,
    deploymentConfigTemplate,
    acpBaseConfig,
  )

  let command: string | undefined
  let args: string[] | undefined
  if (configuredCommand) {
    command = isAbsolute(configuredCommand) ? configuredCommand : resolve(options.projectRoot, configuredCommand)
    await access(command, constants.X_OK)
    args = [...parseStringArray(env['DSH_RUNTIME_ARGS_JSON']), '--config', deploymentConfig]
  } else {
    await access(resolve(home, 'packages/examples/acp-demo/src/bin.ts'), constants.R_OK)
  }

  return {
    home,
    version: metadata.version,
    commit: metadata.commit,
    protocolVersion: metadata.protocolVersion,
    launchMode,
    process: createManagedDshAcpProcessConfiguration({
      runtimeHome: home,
      projectRoot: options.projectRoot,
      command,
      args,
      deploymentConfig,
      env: {
        DSH_ACP_BASE_CONFIG: acpBaseConfig,
        DSH_WORK_DSH_SESSIONS_ROOT: dshSessionsRoot,
      },
    }),
  }
}

function assertExpectedRuntimeLockEnvironment(env: NodeJS.ProcessEnv, lock: RuntimeLock) {
  const expectedVersion = env['DSH_EXPECTED_VERSION']
  if (expectedVersion !== undefined && expectedVersion !== lock.version) {
    throw new Error(`DSH_EXPECTED_VERSION must match runtime lock ${lock.version}, received ${expectedVersion}`)
  }
  const expectedCommit = env['DSH_EXPECTED_COMMIT']
  if (expectedCommit !== undefined && expectedCommit !== lock.commit) {
    throw new Error(`DSH_EXPECTED_COMMIT must match runtime lock ${lock.commit}, received ${expectedCommit}`)
  }
}

async function writeDeploymentOverlay(
  dataRoot: string,
  templatePath: string,
  acpBaseConfig: string,
): Promise<string> {
  const template = await readFile(templatePath, 'utf8')
  const withBaseConfig = template.replace(
    /^([ \t]*path:).*$/m,
    `$1 ${JSON.stringify(acpBaseConfig)}`,
  )
  if (withBaseConfig === template) {
    throw new Error(`DSH deployment overlay template has no include path: ${templatePath}`)
  }
  const toolPolicySource = resolve(dirname(templatePath), 'dsh-work-tool-policy.js')
  await access(toolPolicySource, constants.R_OK)
  const rendered = withBaseConfig.replace(
    '__DSH_WORK_TOOL_POLICY_MODULE__',
    JSON.stringify(toolPolicySource),
  )
  if (rendered === withBaseConfig) {
    throw new Error(`DSH deployment overlay template has no tool policy placeholder: ${templatePath}`)
  }
  const directory = resolve(dataRoot, 'dsh-config')
  const target = resolve(directory, 'acp-managed-credentials.cordis.yml')
  await mkdir(directory, { recursive: true })
  await writeFile(target, rendered, { mode: 0o600 })
  return target
}

/** Start a short-lived ACP process and fail before serving traffic if negotiation is broken. */
export async function preflightDshRuntime(
  installation: DshRuntimeInstallation,
  timeoutMs = 15_000,
): Promise<void> {
  const preflightRoot = await mkdtemp(resolve(tmpdir(), 'dsh-work-dsh-preflight-'))
  const diagnostics: string[] = []
  const client = AcpJsonRpcClient.launch({
    ...installation.process,
    env: {
      ...installation.process.env,
      DSH_SNAPSHOT: 'record',
      DSH_SNAPSHOT_SESSIONS_ROOT: resolve(preflightRoot, 'sessions'),
    },
  }, {
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
    onDiagnostic: message => { diagnostics.push(message) },
  })
  let timeout: NodeJS.Timeout | undefined
  try {
    try {
      await Promise.race([
        client.initialize(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { reject(new Error(`DSH ACP preflight timed out after ${timeoutMs} ms`)) }, timeoutMs)
        }),
      ])
    } catch (error) {
      const detail = diagnostics.join('\n').slice(-4000)
      throw new Error(`DSH ACP preflight failed: ${asError(error).message}${detail ? `\n${detail}` : ''}`)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    await client.close().catch(() => undefined)
    await rm(preflightRoot, { recursive: true, force: true })
  }
}

async function readSourceMetadata(home: string, protocolVersion: number): Promise<RuntimeMetadata> {
  const packageJson = await readJson<{ version?: string }>(resolve(home, 'package.json'))
  if (!packageJson.version) throw new Error(`DSH package.json has no version: ${home}`)
  return {
    version: packageJson.version,
    commit: await gitHead(home),
    protocolVersion,
    acpConfig: 'examples/acp-agent/cordis.yml',
  }
}

function gitHead(cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['rev-parse', 'HEAD'], { cwd }, (error, stdout) => {
      if (error) reject(new Error(`Unable to resolve DSH source commit at ${cwd}: ${error.message}`))
      else resolvePromise(stdout.trim())
    })
  })
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    throw new Error(`Unable to read DSH runtime metadata ${path}: ${asError(error).message}`)
  }
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`DSH_RUNTIME_ARGS_JSON must be a JSON string array: ${asError(error).message}`)
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error('DSH_RUNTIME_ARGS_JSON must be a JSON string array')
  }
  return parsed
}

function assertRuntimeLock(value: RuntimeLock): void {
  if (!value.version || !/^[0-9a-f]{40}$/.test(value.commit) || value.protocolVersion !== 1) {
    throw new Error('DSH runtime lock is invalid')
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
