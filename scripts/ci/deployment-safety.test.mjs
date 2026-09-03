import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const releasePath = join(projectRoot, 'scripts/deploy/release.sh')
const restorePath = join(projectRoot, 'scripts/deploy/restore.sh')
const backupPath = join(projectRoot, 'scripts/deploy/backup.sh')
const buildPath = join(projectRoot, 'scripts/release/build-release.sh')
const preflightPath = join(projectRoot, 'scripts/deploy/preflight.sh')

const [release, restore, backup, build, preflight] = await Promise.all([
  readFile(releasePath, 'utf8'),
  readFile(restorePath, 'utf8'),
  readFile(backupPath, 'utf8'),
  readFile(buildPath, 'utf8'),
  readFile(preflightPath, 'utf8'),
])

const upgradeStart = release.indexOf('if [[ -n "${old_release}" && -d "${old_release}" ]]; then\n  if launchctl')
const upgradeEnd = release.indexOf('\nnode_bin=', upgradeStart)
assert.notEqual(upgradeStart, -1, 'release upgrade block is missing')
assert.notEqual(upgradeEnd, -1, 'release upgrade block is incomplete')
const upgradeBlock = release.slice(upgradeStart, upgradeEnd)
assertOrder(upgradeBlock, '/scripts/deploy/backup.sh', 'mark_attempted')
assertOrder(upgradeBlock, 'mark_attempted', '-f "${compose_file}" up -d --wait postgres')

assertOrder(release, 'tar -xzf "${archive}"', 'if [[ -d "${release_dir}" ]]')
assert.match(release, /mv "\$\{release_dir\}" "\$\{stale_release\}"/)
assert.doesNotMatch(release, /if \[\[ ! -d "\$\{release_dir\}" \]\]; then\s+tar -xzf/)

const restoreOperationStart = restore.lastIndexOf('maintenance_started=true\ntrap cleanup EXIT')
assert.notEqual(restoreOperationStart, -1, 'restore maintenance block is missing')
const restoreOperation = restore.slice(restoreOperationStart)
assertOrder(restoreOperation, 'maintenance_started=true\ntrap cleanup EXIT', 'docker compose --env-file "${runtime_env}" -f "${compose_file}" stop web')
assertOrder(restoreOperation, 'destructive_started=true', 'dropdb --if-exists --force')
assert.match(restore, /restore failed after database replacement began; services remain stopped/)

assert.doesNotMatch(build, /cp -R "\$\{project_root\}\/deploy\/\."/)
assert.match(build, /refusing to build beside sensitive deployment material/)
assert.match(build, /deploy\/runtime\.env\.example/)

assert.match(preflight, /git -C "\$\{runtime_home\}" rev-parse --is-inside-work-tree/)
assert.doesNotMatch(preflight, /-d "\$\{runtime_home\}\/\.git"/)
assert.match(preflight, /offline CA private keys must never be stored on the Mac mini/)
assert.match(backup, /DSH_WORK_OFF_HOST_BACKUP_DIRECTORY/)
assert.match(backup, /storage_class": "off-host"/)
assert.match(backup, /shasum -a 256 -c/)
assert.match(backup, /off-host backup filesystem changed while the backup was being written/)

for (const [script, version] of [[buildPath, '0.1.0-rc.1'], [releasePath, '01.2.3']]) {
  const result = spawnSync('bash', [script, version], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, `${script} accepted non-stable version ${version}`)
  assert.match(result.stderr, /invalid stable release version/)
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-work-deployment-safety.'))
try {
  await verifyDestructiveRestoreFailsClosed(join(fixtureRoot, 'restore'))
  await verifySameFilesystemBackupIsRejected(join(fixtureRoot, 'backup'))
  await verifySensitiveBuildInputIsRejected(join(fixtureRoot, 'build'), build)
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}

async function verifySameFilesystemBackupIsRejected(fixture) {
  const binRoot = join(fixture, 'bin')
  const currentRoot = join(fixture, 'current')
  const offHostRoot = join(fixture, 'off-host')
  const launchctlLog = join(fixture, 'launchctl.log')
  await mkdir(join(currentRoot, 'deploy'), { recursive: true })
  await mkdir(binRoot, { recursive: true })
  await mkdir(offHostRoot, { recursive: true })
  await writeFile(join(currentRoot, 'deploy/compose.yaml'), 'name: backup-test\nservices: {}\n')
  await writeFile(join(fixture, 'runtime.env'), [
    `PATH=${shellQuote(`${binRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`)}`,
    `DSH_WORK_OFF_HOST_BACKUP_DIRECTORY=${shellQuote(offHostRoot)}`,
    `DSH_WORK_DATA_ROOT=${shellQuote(join(fixture, 'data'))}`,
    '',
  ].join('\n'), { mode: 0o600 })
  await writeExecutable(join(binRoot, 'df'), `#!/usr/bin/env bash
printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' '/dev/disk1 100 1 99 1% /'
`)
  await writeExecutable(join(binRoot, 'launchctl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${shellQuote(launchctlLog)}
exit 0
`)

  const result = spawnSync('bash', [backupPath, fixture, currentRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'backup accepted storage on the deployment filesystem')
  assert.match(result.stderr, /must use a filesystem distinct/)
  const launchctlCalled = await readFile(launchctlLog, 'utf8').then(() => true, () => false)
  assert.equal(launchctlCalled, false, 'backup entered maintenance before validating off-host storage')
}

console.log('deployment safety contract tests passed')

function assertOrder(source, before, after) {
  const beforeIndex = source.indexOf(before)
  const afterIndex = source.indexOf(after)
  assert.notEqual(beforeIndex, -1, `missing deployment contract marker: ${before}`)
  assert.notEqual(afterIndex, -1, `missing deployment contract marker: ${after}`)
  assert.ok(beforeIndex < afterIndex, `deployment contract order is invalid: ${before} must precede ${after}`)
}

async function verifyDestructiveRestoreFailsClosed(fixture) {
  const binRoot = join(fixture, 'bin')
  const currentRoot = join(fixture, 'current')
  const backupRoot = join(fixture, 'backup')
  const dockerLog = join(fixture, 'docker.log')
  const installLog = join(fixture, 'install.log')
  await mkdir(join(currentRoot, 'deploy'), { recursive: true })
  await mkdir(join(currentRoot, 'scripts/deploy'), { recursive: true })
  await mkdir(binRoot, { recursive: true })
  await mkdir(backupRoot, { recursive: true })
  await writeFile(join(currentRoot, 'deploy/compose.yaml'), 'name: restore-test\nservices: {}\n')
  await writeFile(join(backupRoot, 'SHA256SUMS'), 'fixture\n')
  await writeFile(join(backupRoot, 'database.dump'), 'fixture\n')
  await writeFile(join(fixture, 'runtime.env'), [
    `PATH=${shellQuote(`${binRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`)}`,
    'DSH_WORK_POSTGRES_USER=dsh_work',
    'DSH_WORK_POSTGRES_DB=dsh_work',
    `DSH_WORK_DATA_ROOT=${shellQuote(join(fixture, 'data'))}`,
    '',
  ].join('\n'), { mode: 0o600 })

  await writeExecutable(join(binRoot, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${shellQuote(dockerLog)}
case "$*" in
  *pg_restore*) exit 42 ;;
  *) exit 0 ;;
esac
`)
  await writeExecutable(join(binRoot, 'launchctl'), `#!/usr/bin/env bash
[[ "\${1:-}" == print ]] && exit 1
exit 0
`)
  await writeExecutable(join(binRoot, 'shasum'), '#!/usr/bin/env bash\nexit 0\n')
  await writeExecutable(join(currentRoot, 'scripts/deploy/install-launchd.sh'), `#!/usr/bin/env bash
printf 'started\\n' >> ${shellQuote(installLog)}
`)

  const result = spawnSync('bash', [restorePath, fixture, backupRoot, '--confirm'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'restore unexpectedly succeeded after pg_restore failure')
  assert.match(result.stderr, /services remain stopped so partial data is not exposed/)
  const dockerCalls = await readFile(dockerLog, 'utf8')
  assert.doesNotMatch(dockerCalls, / up /, 'restore restarted web after destructive failure')
  assert.ok(dockerCalls.match(/ stop web/g)?.length === 2, 'restore did not stop web again after destructive failure')
  const installCalled = await readFile(installLog, 'utf8').then(() => true, () => false)
  assert.equal(installCalled, false, 'restore restarted launchd after destructive failure')
}

async function verifySensitiveBuildInputIsRejected(fixture, buildSource) {
  const fixtureBuild = join(fixture, 'scripts/release/build-release.sh')
  const outputRoot = join(fixture, 'output')
  await mkdir(dirname(fixtureBuild), { recursive: true })
  await mkdir(join(fixture, 'server'), { recursive: true })
  await mkdir(join(fixture, 'deploy'), { recursive: true })
  await writeFile(fixtureBuild, buildSource)
  await chmod(fixtureBuild, 0o755)
  await writeFile(join(fixture, 'server/package.json'), '{"version":"0.1.0"}\n')
  await writeFile(join(fixture, 'deploy/runtime.env'), 'AI_HUB_CLIENT_SECRET=must-not-ship\n', { mode: 0o600 })

  const result = spawnSync('bash', [fixtureBuild, '0.1.0', outputRoot], { encoding: 'utf8' })
  assert.notEqual(result.status, 0, 'release build accepted deploy/runtime.env')
  assert.match(result.stderr, /refusing to build beside sensitive deployment material/)
  const bundleExists = await readFile(join(outputRoot, 'dsh-work-v0.1.0/release.json'), 'utf8')
    .then(() => true, () => false)
  assert.equal(bundleExists, false, 'failed sensitive build left a release payload behind')
}

async function writeExecutable(path, content) {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
