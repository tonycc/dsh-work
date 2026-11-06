import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { runMigrations } from './migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'

// 模型路由方案 MR-S1：迁移 0120 把自由文本的 provider_type 收敛为枚举、补 trust_level、
// 把非默认用途的路由停用并改为 default；之后路由按用途解析，不按标识。
const migrationsDirectory = resolve(import.meta.dirname, '../../../migrations')
const governanceMigration = '0120_model_routing_governance.sql'
const tenantId = 'tenant-dsh-work'
const actor = 'U00008'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let baselineDirectory = ''
let service: ModelGovernanceService

before(async () => {
  baselineDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-model-routing-baseline-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file.endsWith('.sql') && file < governanceMigration) {
      await copyFile(resolve(migrationsDirectory, file), resolve(baselineDirectory, file))
    }
  }
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_model_routing_governance', maxConnections: 3, migrate: false })
  database = throwaway.client
  await runMigrations(database, baselineDirectory)
  await seedLegacyGovernance()
  await runMigrations(database)
  service = new ModelGovernanceService(new PostgresModelGovernanceRepository(database), tenantId)
})

after(async () => {
  await throwaway.dispose()
  await rm(baselineDirectory, { recursive: true, force: true })
})

async function seedLegacyGovernance() {
  await database`
    insert into model_providers (id, tenant_id, key, name, provider_type, base_url, status)
    values ('provider-legacy-free-text', ${tenantId}, 'legacy-free-text', '旧自由文本类型', 'deepseek-official', 'https://legacy.example.com', 'active')
  `
  await database`
    insert into provider_models (id, tenant_id, provider_id, model_key, display_name, capabilities, status)
    values ('model-legacy-chat', ${tenantId}, 'provider-legacy-free-text', 'legacy-chat', '旧对话模型', '["text"]'::jsonb, 'active')
  `
  await database`
    insert into model_routes (id, tenant_id, key, name, purpose, provider_model_id, priority, enabled)
    values
      ('route-legacy-chat', ${tenantId}, 'legacy-chat', '旧对话路由', 'chat', 'model-legacy-chat', 10, true),
      ('route-legacy-analysis', ${tenantId}, 'legacy-analysis', '旧分析路由', 'analysis', 'model-legacy-chat', 20, true)
  `
}

test('migration maps free-text provider types to openai-completions and marks every provider external', async () => {
  const rows = await database<{ id: string; providerType: string; trustLevel: string }[]>`
    select id, provider_type as "providerType", trust_level as "trustLevel"
      from model_providers where tenant_id = ${tenantId} order by id
  `
  assert.deepEqual(rows.map(row => [row.id, row.providerType, row.trustLevel]), [
    ['provider-deepseek-official', 'openai-completions', 'external'],
    ['provider-legacy-free-text', 'openai-completions', 'external'],
  ])
  await assert.rejects(database`
    insert into model_providers (id, tenant_id, key, name, provider_type, trust_level, base_url, status)
    values ('provider-bad-type', ${tenantId}, 'bad-type', '错误类型', 'openai-compatible', 'external', 'https://bad.example.com', 'active')
  `, /model_providers_provider_type_check/)
  await assert.rejects(database`
    insert into model_providers (id, tenant_id, key, name, provider_type, base_url, status)
    values ('provider-no-trust', ${tenantId}, 'no-trust', '未选信任级别', 'openai-completions', 'https://bad.example.com', 'active')
  `, /trust_level/)
})

test('migration disables non-default routes and folds them into the default purpose without touching the seed default', async () => {
  const rows = await database<{ id: string; purpose: string; enabled: boolean }[]>`
    select id, purpose, enabled from model_routes where tenant_id = ${tenantId} order by id
  `
  assert.deepEqual(rows.map(row => [row.id, row.purpose, row.enabled]), [
    ['route-default', 'default', true],
    ['route-legacy-analysis', 'default', false],
    ['route-legacy-chat', 'default', false],
  ])
  await assert.rejects(database`
    update model_routes set purpose = 'fallback' where id = 'route-legacy-chat'
  `, /model_routes_purpose_check/)
})

test('the enabled default route is resolved by purpose, edited in place and switched atomically', async () => {
  const before = await service.resolveDefaultRoute()
  assert.equal(before.routeKey, 'default')
  assert.equal(before.providerType, 'openai-completions')
  assert.equal(before.trustLevel, 'external')

  const providers = await service.listProviders()
  const model = providers.find(item => item.id === 'provider-deepseek-official')!.models[0]!
  const created = await service.createRoute({ key: 'primary-model', name: '主力模型路由', providerModelId: model.id, enabled: true, actor })
  assert.equal(created.purpose, 'default')
  const enabled = (await service.listRoutes()).filter(item => item.enabled).map(item => item.id)
  assert.deepEqual(enabled, [created.id])
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'primary-model', 'a default route whose key is not "default" is still resolved')

  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: true, actor })
  assert.deepEqual((await service.listRoutes()).filter(item => item.enabled).map(item => item.id), ['route-default'])

  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: false, actor })
  await assert.rejects(service.resolveDefaultRoute(), /没有可用的默认模型路由/)
  await service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: model.id, enabled: true, actor })

  await assert.rejects(service.updateRoute({ routeId: 'route-default', name: '平台默认模型路由', providerModelId: 'model-missing', enabled: true, actor }), /目标模型不存在/)
  assert.equal((await service.resolveDefaultRoute()).routeKey, 'default', 'a rejected edit leaves the enabled route unchanged')

  const audit = await database<{ action: string }[]>`
    select action from audit_events where tenant_id = ${tenantId} and object_type = 'model_governance'
  `
  assert.ok(audit.some(row => row.action === 'model_route.update'))
})

test('disabling a model makes its route unavailable and provider edits keep the trust level explicit', async () => {
  const provider = (await service.listProviders()).find(item => item.id === 'provider-deepseek-official')!
  const model = provider.models[0]!
  const disabled = await service.setProviderModelStatus({ modelId: model.id, status: 'disabled', actor })
  assert.equal(disabled.models.find(item => item.id === model.id)?.status, 'disabled')
  await assert.rejects(service.resolveDefaultRoute(), /模型路由目标已停用/)
  await service.setProviderModelStatus({ modelId: model.id, status: 'active', actor })

  const updated = await service.updateProvider({ providerId: provider.id, name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/', trustLevel: 'internal', actor })
  assert.equal(updated.trustLevel, 'internal')
  assert.equal(updated.baseUrl, 'https://api.deepseek.com')
  assert.equal((await service.resolveDefaultRoute()).trustLevel, 'internal')
  await service.updateProvider({ providerId: provider.id, name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', trustLevel: 'external', actor })

  const created = await service.createProvider({ key: 'internal-llm', name: '内网模型', providerType: 'openai-completions', trustLevel: 'internal', baseUrl: 'https://llm.example.internal', actor })
  assert.equal(created.trustLevel, 'internal')
})
