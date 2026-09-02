import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const watcher = join(projectRoot, 'scripts/deploy/watch-release.sh')
const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-work-watcher-test.'))

try {
  const binRoot = join(fixtureRoot, 'bin')
  const deployScripts = join(fixtureRoot, 'scripts/deploy')
  await mkdir(binRoot, { recursive: true })
  await mkdir(deployScripts, { recursive: true })

  await writeFile(join(fixtureRoot, 'runtime.env'), [
    'DSH_WORK_AUTO_DEPLOY_ENABLED=true',
    'DSH_WORK_GITHUB_REPOSITORY=tonycc/dsh-work',
    `DSH_WORK_NODE_BIN=${process.execPath}`,
    `PATH=${binRoot}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    '',
  ].join('\n'), { mode: 0o600 })

  const curlStub = join(binRoot, 'curl')
  await writeFile(curlStub, `#!/usr/bin/env bash
set -euo pipefail
output=''
while (($#)); do
  if [[ "$1" == --output ]]; then
    output=$2
    shift 2
    continue
  fi
  shift
done
cp ${shellQuote(join(fixtureRoot, 'release.json'))} "\${output}"
printf '200'
`)
  await chmod(curlStub, 0o755)

  const releaseStub = join(deployScripts, 'release.sh')
  await writeFile(releaseStub, `#!/usr/bin/env bash
set -euo pipefail
version=\${1:?}
deploy_root=\${2:?}
printf '%s\\n' "\${version}" >> "\${deploy_root}/deploy-invocations"
if [[ "\${version}" == 0.1.1 ]]; then
  printf 'v%s\\n' "\${version}" > "\${deploy_root}/automation/state/attempted-release"
  exit 42
fi
printf 'v%s\\n' "\${version}" > "\${deploy_root}/active-release"
`)
  await chmod(releaseStub, 0o755)

  const staleLock = join(fixtureRoot, 'automation/.watch.lock')
  await mkdir(staleLock, { recursive: true })
  await writeFile(join(staleLock, 'pid'), '99999999\n')

  await writeRelease('v0.1.0')
  runWatcher(0)
  runWatcher(0)
  assert.equal(await readTrimmed('active-release'), 'v0.1.0')
  assert.deepEqual((await readTrimmed('deploy-invocations')).split('\n'), ['0.1.0'])

  await writeRelease('v0.1.1')
  runWatcher(1)
  assert.equal(await readTrimmed('automation/state/blocked-release'), 'v0.1.1')
  runWatcher(0)
  assert.deepEqual((await readTrimmed('deploy-invocations')).split('\n'), ['0.1.0', '0.1.1'])

  await unlink(join(fixtureRoot, 'automation/state/blocked-release'))
  await writeRelease('v0.0.9')
  runWatcher(0)
  assert.equal(await readTrimmed('automation/state/blocked-release'), 'v0.0.9')
  assert.equal(await readTrimmed('active-release'), 'v0.1.0')
  assert.deepEqual((await readTrimmed('deploy-invocations')).split('\n'), ['0.1.0', '0.1.1'])
} finally {
  await rm(fixtureRoot, { recursive: true, force: true })
}

console.log('public Release watcher smoke tests passed')

async function writeRelease(tag) {
  const bundle = `dsh-work-${tag}.tar.gz`
  await writeFile(join(fixtureRoot, 'release.json'), `${JSON.stringify({
    tag_name: tag,
    target_commitish: 'eda30ff8af32743f27e757740c6a298373912f38',
    draft: false,
    prerelease: false,
    immutable: true,
    author: { login: 'github-actions[bot]' },
    assets: [
      { name: bundle, state: 'uploaded' },
      { name: `${bundle}.sha256`, state: 'uploaded' },
    ],
  }, null, 2)}\n`)
}

function runWatcher(expectedStatus) {
  const result = spawnSync('bash', [watcher, fixtureRoot], { encoding: 'utf8' })
  assert.equal(
    result.status,
    expectedStatus,
    `watcher exit mismatch\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  )
}

async function readTrimmed(path) {
  return (await readFile(join(fixtureRoot, path), 'utf8')).trim()
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
