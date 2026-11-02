import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PostgresAgentAccessService } from '../../modules/agent/agent-access-service.ts'
import { agentSpecFromConfiguration } from '../../modules/agent/agent-spec.ts'
import { PostgresAgentValidationService } from '../../modules/agent/agent-validation-service.ts'
import { PostgresAgentService } from '../../modules/agent/postgres-agent-service.ts'
import { loadSkillCreatorPreset, seedSkillCreatorDraft } from '../../modules/agent/skill-creator-preset.ts'
import { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

if (!process.env.DSH_WORK_TEST_DATABASE_URL) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

const presetRoot = fileURLToPath(new URL('../../../config/agent-presets', import.meta.url))
const preset = loadSkillCreatorPreset(presetRoot)
const EMPLOYEE = 'U00001'
const ADMIN = 'U00008'

let throwaway: ThrowawayDatabase
let agents: PostgresAgentService
let validation: PostgresAgentValidationService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_creator_preset_test', maxConnections: 4 })
  const skills = new PostgresSkillService(throwaway.client)
  agents = new PostgresAgentService(throwaway.client, undefined, skills)
  validation = new PostgresAgentValidationService(throwaway.client, agents, skills)
})

after(async () => {
  await throwaway?.dispose()
})

test('SKC-05: preset definition matches plan 5.1 and 5.2', () => {
  assert.equal(preset.systemPrompt, readFileSync(new URL('../../../config/agent-presets/skill-creator/SOUL.md', import.meta.url), 'utf8'))
  assert.equal(preset.name, 'Skill 创建专家')
  assert.equal(preset.examplePrompts.length, 3)
  assert.equal(preset.testPrompts.length, 5)
})

test('SKC-05: a fresh environment gets an unpublished draft with no audience or roles', async () => {
  const seeded = await seedSkillCreatorDraft(throwaway.client, agents, validation, preset)
  assert.deepEqual(seeded, { status: 'created', agentId: preset.id })

  const [row] = await throwaway.client<{
    status: string; activeVersionId: string | null; visibleRoleIds: string[]; ownerUserId: string
    versionStatus: string; skillCreation: boolean; recommendation: boolean; webSearch: boolean
    systemPrompt: string; spec: unknown; mcpScope: unknown
  }[]>`
    select a.status, a.active_version_id as "activeVersionId", a.visible_role_ids as "visibleRoleIds",
           a.owner_user_id as "ownerUserId", v.status as "versionStatus", v.skill_creation_enabled as "skillCreation",
           v.agent_recommendation_enabled as recommendation, v.web_search_enabled as "webSearch",
           v.system_prompt as "systemPrompt", v.agent_spec as spec, v.mcp_scope as "mcpScope"
      from agents a join agent_versions v on v.tenant_id = a.tenant_id and v.id = a.draft_version_id
     where a.id = ${preset.id}
  `
  assert.ok(row)
  assert.equal(row.status, 'draft')
  assert.equal(row.activeVersionId, null)
  assert.equal(row.versionStatus, 'draft')
  assert.deepEqual(row.visibleRoleIds, [])
  assert.equal(row.ownerUserId, ADMIN)
  assert.equal(row.skillCreation, true)
  assert.equal(row.recommendation, false)
  assert.equal(row.webSearch, false)
  assert.deepEqual(row.mcpScope, { mode: 'none', connectorIds: [] })
  assert.equal(row.systemPrompt, preset.systemPrompt.trim())
  assert.deepEqual(row.spec, agentSpecFromConfiguration({
    id: preset.id, name: preset.name, description: preset.description, welcomeMessage: preset.welcomeMessage,
    examplePrompts: preset.examplePrompts, systemPrompt: preset.systemPrompt.trim(), skills: [],
    webSearchEnabled: false, projectTasksEnabled: false, agentRecommendationEnabled: false, skillCreationEnabled: true,
    timeoutSeconds: 300, maxToolCalls: 20, maxOutputBytes: 65536,
  }, '0.1.0'))

  const overview = await validation.getOverview(preset.id)
  assert.deepEqual(overview.testCases.map(item => item.prompt), preset.testPrompts)
  const failed = overview.checks.filter(check => !check.passed).map(check => check.id).sort()
  assert.deepEqual(failed, ['audience', 'roles'])

  // 未发布：员工的 AI 同事列表（Skill 广场入口与推荐的同一口径）看不到它。
  const visible = await agents.listWorkbenchAgents(EMPLOYEE)
  assert.ok(!visible.some(agent => agent.id === preset.id))
})

test('SKC-05: after the admin picks roles every release check passes', async () => {
  const access = new PostgresAgentAccessService(throwaway.client)
  const current = await access.getAccess(preset.id)
  await access.updateAccess({
    agentId: preset.id, actor: ADMIN, expectedRevision: current.revision,
    visibleRoleIds: ['role-employee', 'role-platform-admin'], roleIds: ['role-employee'], dataScopes: [],
  })
  const overview = await validation.getOverview(preset.id)
  assert.deepEqual(overview.checks.filter(check => !check.passed), [])
})

test('SKC-05: restarting does not seed again', async () => {
  assert.deepEqual(await seedSkillCreatorDraft(throwaway.client, agents, validation, preset), { status: 'skipped', reason: 'exists' })
  const [{ count }] = await throwaway.client<{ count: number }[]>`
    select count(*)::int as count from agent_versions where skill_creation_enabled
  `
  assert.equal(count, 1)
})

test('SKC-05: an existing creator Agent (any id, unpublished) prevents seeding', async () => {
  const other = await createThrowawayDatabase({ namePrefix: 'dsh_work_skill_creator_preset_other', maxConnections: 4 })
  try {
    const skills = new PostgresSkillService(other.client)
    const otherAgents = new PostgresAgentService(other.client, undefined, skills)
    await otherAgents.createAgent({
      id: 'agent-admin-made-creator', name: '管理员自建的专家', description: '管理员自己创建的 Skill 创建专家', owner: '', department: '',
      welcomeMessage: '', examplePrompts: ['帮我做个 Skill'], systemPrompt: '你帮员工把反复使用的工作方法写成 Skill 草稿，保存后由员工提交审核。',
      maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300, skills: [], skillCreationEnabled: true,
      changeSummary: '自建', actor: ADMIN,
    })
    const result = await seedSkillCreatorDraft(other.client, otherAgents, new PostgresAgentValidationService(other.client, otherAgents, skills), preset)
    assert.deepEqual(result, { status: 'skipped', reason: 'exists' })
    const [{ count }] = await other.client<{ count: number }[]>`select count(*)::int as count from agents where id = ${preset.id}`
    assert.equal(count, 0)
  } finally {
    await other.dispose()
  }
})
