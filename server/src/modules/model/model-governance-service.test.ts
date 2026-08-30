import assert from 'node:assert/strict'
import test from 'node:test'

import { MemoryModelGovernanceRepository } from './memory-model-governance-repository.ts'
import { ModelGovernanceService } from './model-governance-service.ts'

test('default DSH provider resolves without exposing a secret value', async () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  const providers = await service.listProviders()
  assert.equal(providers[0]?.credential?.backend, 'dsh-managed')
  assert.equal(providers[0]?.credential?.externalRef, 'DEEPSEEK_API_KEY')
  assert.equal('secret' in (providers[0]?.credential ?? {}), false)

  const route = await service.resolveRoute()
  assert.equal(route.providerKey, 'deepseek-official')
  assert.equal(route.modelKey, 'deepseek-v4-pro')
  assert.equal('secret' in route, false)
})

test('provider and model keys are validated before persistence', () => {
  const service = new ModelGovernanceService(new MemoryModelGovernanceRepository())
  assert.throws(
    () => service.createProvider({
      key: 'Bad Key',
      name: '测试 Provider',
      providerType: 'openai-compatible',
      baseUrl: 'https://example.com',
      actor: 'user-platform-admin',
    }),
    /Provider 标识/,
  )
})
