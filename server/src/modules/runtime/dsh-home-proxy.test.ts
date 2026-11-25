import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { inheritedEnvironmentKeys } from './acp-json-rpc-client.ts'
import { dshHomeDirectory, dshHomeProxyConfigured } from './dsh-home-proxy.ts'

test('DSH home follows DSH_HOME and falls back to ~/.dsh like DSH itself', () => {
  assert.equal(dshHomeDirectory({ DSH_HOME: '/srv/dsh-home' }), '/srv/dsh-home')
  assert.equal(dshHomeDirectory({ DSH_HOME: '  ' }), join(homedir(), '.dsh'))
  assert.equal(dshHomeDirectory({}), join(homedir(), '.dsh'))
})

test('a proxy in the DSH home .env disables web_fetch; comments, other names and empty values do not', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  const env = { DSH_HOME: home }
  assert.equal(await dshHomeProxyConfigured(env), false, 'no .env file')
  for (const [content, expected] of [
    ['DEEPSEEK_API_KEY=x\n# HTTP_PROXY=http://proxy:8080\nNO_PROXY=localhost\n', false],
    ['HTTPS_PROXY=\n', false],
    ['HTTPS_PROXY=""\n', false],
    ['https_proxy=http://proxy:8080\n', true],
    ['export ALL_PROXY = socks5://proxy:1080 # corp\n', true],
    ['HTTP_PROXY="http://proxy:8080"\r\n', true],
  ] as const) {
    await writeFile(join(home, '.env'), content)
    assert.equal(await dshHomeProxyConfigured(env), expected, JSON.stringify(content))
  }
})

test('an unreadable DSH home .env fails closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  await mkdir(join(home, '.env'))
  assert.equal(await dshHomeProxyConfigured({ DSH_HOME: home }), true, 'a directory named .env cannot be read')
  const file = await mkdtemp(join(tmpdir(), 'dsh-home-proxy-'))
  await writeFile(join(file, '.env'), 'HTTP_PROXY=http://proxy\n')
  await chmod(join(file, '.env'), 0o000)
  if (process.getuid?.() !== 0) assert.equal(await dshHomeProxyConfigured({ DSH_HOME: file }), true)
})

test('the ACP launch never inherits proxy variables, so only the DSH home .env can route web_fetch through a proxy', () => {
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    assert.equal((inheritedEnvironmentKeys as readonly string[]).some(key => key.toUpperCase() === name), false, name)
  }
})
