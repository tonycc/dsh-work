import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const [bundleRoot, version, commit] = process.argv.slice(2)
if (!bundleRoot || !version || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('usage: write-release-manifest.mjs BUNDLE_ROOT VERSION COMMIT')
}

const files = []
await visit(bundleRoot)
files.sort((left, right) => left.path.localeCompare(right.path))

await writeFile(join(bundleRoot, 'release.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'dsh-work',
  version,
  commit,
  platform: 'darwin-arm64',
  nodeRuntime: 'host-managed',
  dshRuntime: 'host-managed-locked-checkout',
  createdAt: new Date().toISOString(),
  files,
}, null, 2)}\n`)

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(path)
      continue
    }
    if (!entry.isFile()) continue
    const data = await readFile(path)
    files.push({
      path: relative(bundleRoot, path),
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
  }
}
