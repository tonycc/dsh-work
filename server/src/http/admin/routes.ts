import type { PublishStatus, SkillDefinition, SkillReleaseRecord, SkillVersionRecord } from '../../domain/types.ts'
import type { AdminQueryService } from '../../modules/admin/application/admin-query-service.ts'
import { envelope, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerAdminRoutes(router: Router, service: AdminQueryService) {
  router.get(`${basePath}/session`, async () => envelope('admin', await service.getSession()))
  router.get(`${basePath}/tasks`, async () => envelope('admin', await service.getTaskSummaries()))
  router.get(`${basePath}/runtimes`, async () => envelope('admin', await service.getRuntimes()))
  router.post(`${basePath}/runtimes/check`, async (request) =>
    envelope('admin', await service.checkRuntime(await readJsonBody(request))),
  )
  router.patch(`${basePath}/runtimes/configuration`, async (request) =>
    envelope('admin', await service.updateRuntimeConfiguration(await readJsonBody(request))),
  )
  router.get(`${basePath}/sessions`, async () => envelope('admin', await service.getSessions()))
  router.get(`${basePath}/workspaces`, async () => envelope('admin', await service.getManagedWorkspaces()))
  router.get(`${basePath}/agents`, async () => envelope('admin', await service.getAgents()))
  router.get(`${basePath}/agent-versions`, async () => envelope('admin', await service.getAgentVersions()))
  router.get(`${basePath}/agent-release-records`, async () => envelope('admin', await service.getAgentReleaseRecords()))
  router.post(`${basePath}/agents`, async (request) =>
    envelope('admin', await service.createAgentDraft(await readJsonBody(request))),
  )
  router.patch(`${basePath}/agents/draft`, async (request) =>
    envelope('admin', await service.updateAgentDraft(await readJsonBody(request))),
  )
  router.post(`${basePath}/agents/test`, async (request) => {
    const input = await readJsonBody<{ agentId: string; prompt: string; actor: string }>(request)
    if (!input.actor.trim()) throw new Error('操作人不能为空')
    if (input.prompt.trim().length < 4) throw new Error('测试问题至少需要 4 个字符')
    const agent = (await service.getAgents()).find(item => item.id === input.agentId)
    if (!agent) throw new Error(`Agent 不存在：${input.agentId}`)
    if (agent.status !== 'draft') throw new Error('当前 Agent 没有待测试的草稿版本')
    return envelope('admin', {
      id: `agent-test-${Date.now()}`,
      agentId: agent.id,
      version: agent.version,
      status: 'passed',
      resultSummary: `原型配置校验通过：${agent.skills.length} 个 Skill、${agent.tools.length} 个工具引用。`,
      testedAt: new Date().toISOString(),
    })
  })
  router.patch(`${basePath}/agents/status`, async (request) =>
    envelope('admin', await service.setAgentStatus(await readJsonBody(request))),
  )
  router.post(`${basePath}/agents/rollback`, async (request) =>
    envelope('admin', await service.rollbackAgent(await readJsonBody(request))),
  )
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills()))
  router.get(`${basePath}/skill-versions`, async () => envelope(
    'admin',
    (await service.getSkills()).map(prototypeSkillVersion),
  ))
  router.get(`${basePath}/skill-release-records`, async () => envelope('admin', []))
  router.post(`${basePath}/skills`, async (request) => {
    const skill = await service.createSkill(await readJsonBody(request))
    return envelope('admin', { skill, version: prototypeSkillVersion(skill) })
  })
  router.patch(`${basePath}/skills`, async (request) => {
    const skill = await service.updateSkill(await readJsonBody(request))
    return envelope('admin', { skill, version: prototypeSkillVersion(skill) })
  })
  router.post(`${basePath}/skills/test`, async (request) => {
    const input = await readJsonBody<{ skillId: string; prompt?: string; actor: string }>(request)
    const skill = (await service.getSkills()).find(item => item.id === input.skillId)
    if (!skill) throw new Error(`Skill 不存在：${input.skillId}`)
    return envelope('admin', {
      id: `skill-test-${Date.now()}`,
      skillId: skill.id,
      version: skill.version,
      status: 'passed',
      resultSummary: `原型配置校验通过：${skill.toolIds.length} 个工具引用。`,
      testedAt: new Date().toISOString(),
    })
  })
  router.patch(`${basePath}/skills/status`, async (request) => {
    const input = await readJsonBody<{ skillId: string; status: Extract<PublishStatus, 'published' | 'disabled'>; actor: string }>(request)
    const previous = (await service.getSkills()).find(item => item.id === input.skillId)
    const skill = await service.setSkillStatus(input)
    const action: SkillReleaseRecord['action'] = input.status === 'disabled'
      ? 'disabled'
      : previous?.status === 'draft' ? 'published' : 'enabled'
    return envelope('admin', {
      skill,
      release: prototypeSkillRelease(skill, input.actor, action),
    })
  })
  router.post(`${basePath}/skills/rollback`, async (request) => {
    const input = await readJsonBody<{ skillId: string; version: string; actor: string }>(request)
    const skill = (await service.getSkills()).find(item => item.id === input.skillId && item.version === input.version)
    if (!skill) throw new Error(`原型模式仅保留当前 Skill Version：${input.skillId}@${input.version}`)
    return envelope('admin', { skill, release: prototypeSkillRelease(skill, input.actor, 'rollback') })
  })
  router.get(`${basePath}/tools`, async () => envelope('admin', await service.getTools()))
  router.patch(`${basePath}/tools/status`, async (request) =>
    envelope('admin', await service.setToolStatus(await readJsonBody(request))),
  )
  router.get(`${basePath}/connectors`, async () => envelope('admin', await service.getConnectors()))
  router.post(`${basePath}/connectors/check`, async (request) =>
    envelope('admin', await service.checkConnector(await readJsonBody(request))),
  )
  router.get(`${basePath}/roles`, async () => envelope('admin', await service.getRoles()))
  router.get(`${basePath}/members`, async () => envelope('admin', await service.getMembers()))
  router.patch(`${basePath}/roles`, async (request) =>
    envelope('admin', await service.updateRole(await readJsonBody(request))),
  )
  router.patch(`${basePath}/tools/permissions`, async (request) =>
    envelope('admin', await service.updateToolPermissions(await readJsonBody(request))),
  )
  router.get(`${basePath}/audit-events`, async () => envelope('admin', await service.getAuditEvents()))
  router.get(`${basePath}/operations/summary`, async () => envelope('admin', await service.getOperationsSummary()))
  router.get(`${basePath}/health`, async () => envelope('admin', await service.getHealth()))
  router.get(`${basePath}/usage`, async () => envelope('admin', await service.getUsage()))
  router.get(`${basePath}/model-usage`, async () => envelope('admin', await service.getModelUsage()))
  router.get(`${basePath}/platform-status`, () => envelope('admin', service.getPlatformStatus()))
}

function prototypeSkillVersion(skill: SkillDefinition): SkillVersionRecord {
  return {
    id: `prototype-version-${skill.id}-${skill.version}`,
    skillId: skill.id,
    version: skill.version,
    name: skill.name,
    category: skill.category,
    description: skill.description,
    instructions: skill.instructions,
    toolIds: [...skill.toolIds],
    testPrompt: skill.testPrompt,
    status: skill.status,
    createdAt: skill.updatedAt,
    createdBy: skill.owner,
    summary: '原型模式当前版本',
  }
}

function prototypeSkillRelease(
  skill: SkillDefinition,
  actor: string,
  action: SkillReleaseRecord['action'],
): SkillReleaseRecord {
  return {
    id: `prototype-release-${Date.now()}`,
    skillId: skill.id,
    version: skill.version,
    action,
    actor,
    time: new Date().toISOString().slice(0, 16).replace('T', ' '),
    note: '原型模式发布记录；接入 PostgreSQL 后持久化。',
  }
}
