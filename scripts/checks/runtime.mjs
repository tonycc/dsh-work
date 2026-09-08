function environmentValues(source) {
  return Object.fromEntries([...source.matchAll(/^([A-Z_]+)=(.*)$/gm)].map(match => [match[1], match[2].trim()]))
}

export function checkRuntime(check) {
  const lock = check.json('server/config/dsh/runtime-lock.json')
  const targets = [lock, ...Object.values(lock?.compatibility ?? {})]
  for (const target of targets) {
    check.assert(typeof target?.version === 'string' && target.version.length > 0, 'DSH Lock 缺少版本')
    check.assert(/^[0-9a-f]{40}$/.test(target?.commit ?? ''), 'DSH Lock 必须固定完整 Commit SHA')
    check.assert(target?.protocolVersion === 1, 'DSH Lock 的 ACP protocolVersion 必须为 1')
    check.assert(['official-acp-profile', 'legacy-acp-demo'].includes(target?.adapter), 'DSH Lock Adapter 无效')
  }
  check.assert(lock?.adapter === 'official-acp-profile', '生产 DSH 必须使用正式 ACP profile')
  for (const target of Object.values(lock?.compatibility ?? {})) {
    check.assert(target?.scope === 'development', 'DSH 兼容模式只允许 development')
  }
  const production = environmentValues(check.read('deploy/runtime.env.example'))
  const local = environmentValues(check.read('.env.example'))
  const localTarget = local.DSH_RUNTIME_COMPATIBILITY ? lock?.compatibility?.[local.DSH_RUNTIME_COMPATIBILITY] : lock
  check.assert(Boolean(localTarget), '本地模板选择了未知的 DSH 兼容模式')
  for (const [values, target, label] of [[production, lock, '生产'], [local, localTarget, '本地']]) {
    check.assert(values.DSH_EXPECTED_VERSION === target?.version, `${label} DSH Version 与 Lock 不一致`)
    check.assert(values.DSH_EXPECTED_COMMIT === target?.commit, `${label} DSH Commit 与 Lock 不一致`)
  }
  check.assert(!production.DSH_RUNTIME_COMPATIBILITY, '生产模板不得启用开发兼容模式')
  check.includes('scripts/deploy/preflight.sh', [
    'DSH_RUNTIME_COMPATIBILITY is development-only',
    'apps/cli/src/bin.ts', 'apps/cli/lib/bin.js', 'packages/bundle/acp-app/cordis.patch.yml',
  ])
  check.files(['server/migrations/0019_dsh_runtime_0_1_2_rc_1.sql', 'scripts/runtime/probe.ts'])
  for (const suffix of ['', '.legacy']) {
    check.includes(`server/config/dsh/acp-managed-credentials${suffix}.cordis.yml`, ['DSH_AGENT_SYSTEM_PROMPT'])
  }
  const scripts = check.json('package.json')?.scripts ?? {}
  for (const mode of ['handshake', 'model', 'tool', 'artifact', 'cancel', 'concurrency']) {
    check.assert(scripts[`probe:${mode}`] === `pnpm probe -- ${mode}`, `缺少 probe:${mode} 探针入口`)
  }
}
