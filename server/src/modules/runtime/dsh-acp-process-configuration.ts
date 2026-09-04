import { resolve } from 'node:path'
import type { AcpProcessConfiguration } from './acp-json-rpc-client.ts'

export type DshAcpAdapter = 'official-acp-profile' | 'legacy-acp-demo'

export interface ManagedDshAcpProcessOptions {
  /** Installed DSH runtime root. `dshRepository` remains as a development compatibility alias. */
  runtimeHome?: string
  dshRepository?: string
  projectRoot: string
  command?: string
  args?: string[]
  deploymentConfig?: string
  adapter?: DshAcpAdapter
  acpBaseConfig?: string
  env?: Record<string, string>
  shutdownGraceMs?: number
}

/** Build an ACP launch configuration that resolves model settings and credentials inside DSH. */
export function createManagedDshAcpProcessConfiguration(
  options: ManagedDshAcpProcessOptions,
): AcpProcessConfiguration {
  const configuredHome = options.runtimeHome ?? options.dshRepository
  if (!configuredHome) throw new Error('DSH runtime home is required')
  const runtimeHome = resolve(configuredHome)
  const adapter = options.adapter ?? 'official-acp-profile'
  const deploymentConfig = options.deploymentConfig ?? resolve(
    options.projectRoot,
    adapter === 'legacy-acp-demo'
      ? 'server/config/dsh/acp-managed-credentials.legacy.cordis.yml'
      : 'server/config/dsh/acp-managed-credentials.cordis.yml',
  )
  const acpBaseConfig = options.acpBaseConfig ?? resolve(runtimeHome, 'examples/acp-agent/cordis.yml')
  return {
    command: options.command ?? process.execPath,
    args: options.args ?? (adapter === 'legacy-acp-demo'
      ? [
          '--import',
          'tsx',
          'packages/examples/acp-demo/src/bin.ts',
          '--config',
          deploymentConfig,
        ]
      : [
          '--import',
          'tsx/esm',
          'apps/cli/src/bin.ts',
          '--profile',
          'acp',
          '--patch',
          deploymentConfig,
        ]),
    cwd: runtimeHome,
    env: {
      ...(adapter === 'legacy-acp-demo' ? { DSH_ACP_BASE_CONFIG: acpBaseConfig } : {}),
      ...options.env,
    },
    shutdownGraceMs: options.shutdownGraceMs,
  }
}
