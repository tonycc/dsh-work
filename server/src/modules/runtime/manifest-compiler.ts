import { canonicalJson, sha256 } from './canonical-json.ts'
import type { CompiledRuntimeManifest, RuntimeManifest } from './runtime-types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function assertId(name: string, value: string): void {
  if (!ID_PATTERN.test(value)) throw new TypeError(`${name} is invalid`)
}

export function compileRuntimeManifest(input: RuntimeManifest): CompiledRuntimeManifest {
  if (input.manifest_version !== '1.0') throw new TypeError('manifest_version must be 1.0')
  assertId('run_id', input.run_id)
  assertId('attempt_id', input.attempt_id)
  assertId('session_id', input.session_id)
  assertId('user_context.user_id', input.user_context.user_id)
  assertId('user_context.tenant_id', input.user_context.tenant_id)

  if (input.input.message.trim().length === 0) throw new TypeError('input.message must not be blank')
  if (input.limits.timeout_seconds < 1 || input.limits.timeout_seconds > 3600) {
    throw new RangeError('limits.timeout_seconds must be between 1 and 3600')
  }
  if (input.limits.max_output_bytes < 1024) throw new RangeError('limits.max_output_bytes must be at least 1024')
  if (input.limits.max_tool_calls < 0 || input.limits.max_tool_calls > 1000) {
    throw new RangeError('limits.max_tool_calls must be between 0 and 1000')
  }

  for (const mount of input.input.file_mounts) {
    if (!mount.mount_path.startsWith('/workspace/input/')) {
      throw new TypeError('file mount paths must start with /workspace/input/')
    }
    if (mount.access !== 'read_only') throw new TypeError('input file mounts must be read_only')
  }

  const manifest = structuredClone(input)
  const serialized = canonicalJson(manifest)
  return { manifest, canonicalJson: serialized, sha256: sha256(serialized) }
}
