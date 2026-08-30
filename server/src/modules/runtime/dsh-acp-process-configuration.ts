import { resolve } from 'node:path'
import type { AcpProcessConfiguration } from './acp-json-rpc-client.ts'

export interface ManagedDshAcpProcessOptions {
  dshRepository: string
  projectRoot: string
  env?: Record<string, string>
  shutdownGraceMs?: number
}

/** Build an ACP launch configuration that resolves model settings and credentials inside DSH. */
export function createManagedDshAcpProcessConfiguration(
  options: ManagedDshAcpProcessOptions,
): AcpProcessConfiguration {
  const dshRepository = resolve(options.dshRepository)
  const pinnedSiblingRepository = resolve(options.projectRoot, '../deepseek-harness')
  if (dshRepository !== pinnedSiblingRepository) {
    throw new Error(`DSH repository must match the pinned sibling checkout: ${pinnedSiblingRepository}`)
  }
  const deploymentConfig = resolve(
    options.projectRoot,
    'server/config/dsh/acp-managed-credentials.cordis.yml',
  )
  return {
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      'packages/examples/acp-demo/src/bin.ts',
      '--config',
      deploymentConfig,
    ],
    cwd: dshRepository,
    env: options.env,
    shutdownGraceMs: options.shutdownGraceMs,
  }
}
