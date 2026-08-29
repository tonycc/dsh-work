import { ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type {
  AdminTaskSummary,
  AgentDefinition,
  AgentDraftConfiguration,
  AgentReleaseRecord,
  AgentVersionRecord,
  AuditEvent,
  ConnectorDefinition,
  HealthComponent,
  MemberDefinition,
  ManagedWorkspaceDefinition,
  ModelUsageRecord,
  PlatformStatus,
  RoleDefinition,
  RuntimeDefinition,
  SessionDefinition,
  SkillConfiguration,
  SkillDefinition,
  ToolDefinition,
  UpdateRuntimeConfigurationInput,
  UsagePoint,
} from '../types/domain'

export const useContentStore = defineStore('admin-content', () => {
  const tasks = ref<AdminTaskSummary[]>([])
  const runtimes = ref<RuntimeDefinition[]>([])
  const sessions = ref<SessionDefinition[]>([])
  const workspaces = ref<ManagedWorkspaceDefinition[]>([])
  const agents = ref<AgentDefinition[]>([])
  const agentVersions = ref<AgentVersionRecord[]>([])
  const agentReleaseRecords = ref<AgentReleaseRecord[]>([])
  const skills = ref<SkillDefinition[]>([])
  const tools = ref<ToolDefinition[]>([])
  const connectors = ref<ConnectorDefinition[]>([])
  const roles = ref<RoleDefinition[]>([])
  const members = ref<MemberDefinition[]>([])
  const auditEvents = ref<AuditEvent[]>([])
  const health = ref<HealthComponent[]>([])
  const usage = ref<UsagePoint[]>([])
  const modelUsage = ref<ModelUsageRecord[]>([])
  const platformStatus = ref<PlatformStatus | null>(null)
  const loading = ref(false)
  const error = ref('')
  const initialized = ref(false)

  async function load(force = false) {
    if (initialized.value && !force) return
    loading.value = true
    error.value = ''
    try {
      const [
        taskData,
        runtimeData,
        sessionData,
        workspaceData,
        agentData,
        agentVersionData,
        agentReleaseData,
        skillData,
        toolData,
        connectorData,
        roleData,
        memberData,
        auditData,
        healthData,
        usageData,
        modelUsageData,
        statusData,
      ] = await Promise.all([
        adminApi.getTasks(),
        adminApi.getRuntimes(),
        adminApi.getSessions(),
        adminApi.getWorkspaces(),
        adminApi.getAgents(),
        adminApi.getAgentVersions(),
        adminApi.getAgentReleaseRecords(),
        adminApi.getSkills(),
        adminApi.getTools(),
        adminApi.getConnectors(),
        adminApi.getRoles(),
        adminApi.getMembers(),
        adminApi.getAuditEvents(),
        adminApi.getHealth(),
        adminApi.getUsage(),
        adminApi.getModelUsage(),
        adminApi.getPlatformStatus(),
      ])
      tasks.value = taskData
      runtimes.value = runtimeData
      sessions.value = sessionData
      workspaces.value = workspaceData
      agents.value = agentData
      agentVersions.value = agentVersionData
      agentReleaseRecords.value = agentReleaseData
      skills.value = skillData
      tools.value = toolData
      connectors.value = connectorData
      roles.value = roleData
      members.value = memberData
      auditEvents.value = auditData
      health.value = healthData
      usage.value = usageData
      modelUsage.value = modelUsageData
      platformStatus.value = statusData
      initialized.value = true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '管理数据加载失败，请稍后重试'
    } finally {
      loading.value = false
    }
  }

  async function setAgentStatus(
    agentId: string,
    status: 'published' | 'disabled',
    actor: string,
  ) {
    const result = await adminApi.setAgentStatus({ agentId, status, actor })
    replaceById(agents.value, result.agent)
    agentReleaseRecords.value.unshift(result.release)
    const version = agentVersions.value.find(
      (item) => item.agentId === agentId && item.version === result.agent.version,
    )
    if (version) version.status = status
    return result.agent
  }

  async function createAgentDraft(input: AgentDraftConfiguration, actor: string) {
    const result = await adminApi.createAgentDraft({ ...input, actor })
    agents.value.unshift(result.agent)
    agentVersions.value.unshift(result.version)
    return result.agent
  }

  async function updateAgentDraft(input: AgentDraftConfiguration, actor: string) {
    const { id, ...configuration } = input
    const result = await adminApi.updateAgentDraft({
      agentId: id,
      actor,
      ...configuration,
    })
    replaceById(agents.value, result.agent)
    replaceById(agentVersions.value, result.version)
    return result.agent
  }

  async function rollbackAgent(agentId: string, version: string, actor: string) {
    const result = await adminApi.rollbackAgent({ agentId, version, actor })
    replaceById(agents.value, result.agent)
    agentReleaseRecords.value.unshift(result.release)
    const target = agentVersions.value.find(
      (item) => item.agentId === agentId && item.version === version,
    )
    if (target) target.status = 'published'
    return result.agent
  }

  async function updateRole(input: {
    roleId: string
    agents: string[]
    tools: string[]
    dataScopes: string[]
  }) {
    const role = await adminApi.updateRole(input)
    replaceById(roles.value, role)
    return role
  }

  async function updateToolPermissions(input: {
    toolId: string
    allowedRoles: string[]
    dataScopes: string[]
    approvalPolicy: ToolDefinition['approvalPolicy']
  }) {
    const tool = await adminApi.updateToolPermissions(input)
    replaceById(tools.value, tool)
    return tool
  }

  async function createSkill(input: Omit<SkillConfiguration, 'id'>, actor: string) {
    const skill = await adminApi.createSkill({ ...input, actor })
    skills.value.unshift(skill)
    return skill
  }

  async function updateSkill(input: SkillConfiguration, actor: string) {
    const { id, ...configuration } = input
    const skill = await adminApi.updateSkill({ skillId: id, actor, ...configuration })
    replaceById(skills.value, skill)
    return skill
  }

  async function setSkillStatus(
    skillId: string,
    status: 'published' | 'disabled',
    actor: string,
  ) {
    const skill = await adminApi.setSkillStatus({ skillId, status, actor })
    replaceById(skills.value, skill)
    return skill
  }

  async function setToolStatus(
    toolId: string,
    status: 'available' | 'disabled',
    actor: string,
  ) {
    const tool = await adminApi.setToolStatus({ toolId, status, actor })
    replaceById(tools.value, tool)
    return tool
  }

  async function checkConnector(connectorId: string, actor: string) {
    const connector = await adminApi.checkConnector({ connectorId, actor })
    replaceById(connectors.value, connector)
    return connector
  }

  async function checkRuntime(runtimeId: string, actor: string) {
    const runtime = await adminApi.checkRuntime({ runtimeId, actor })
    replaceById(runtimes.value, runtime)
    return runtime
  }

  async function updateRuntimeConfiguration(input: UpdateRuntimeConfigurationInput) {
    const runtime = await adminApi.updateRuntimeConfiguration(input)
    replaceById(runtimes.value, runtime)
    return runtime
  }

  return {
    tasks,
    runtimes,
    sessions,
    workspaces,
    agents,
    agentVersions,
    agentReleaseRecords,
    skills,
    tools,
    connectors,
    roles,
    members,
    auditEvents,
    health,
    usage,
    modelUsage,
    platformStatus,
    loading,
    error,
    initialized,
    load,
    createAgentDraft,
    updateAgentDraft,
    setAgentStatus,
    rollbackAgent,
    createSkill,
    updateSkill,
    setSkillStatus,
    setToolStatus,
    checkConnector,
    checkRuntime,
    updateRuntimeConfiguration,
    updateRole,
    updateToolPermissions,
  }
})

function replaceById<T extends { id: string }>(collection: T[], item: T) {
  const index = collection.findIndex((candidate) => candidate.id === item.id)
  if (index >= 0) collection.splice(index, 1, item)
}
