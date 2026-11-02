import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import type { PostgresAgentValidationService } from './agent-validation-service.ts'
import type { PostgresAgentService } from './postgres-agent-service.ts'

const tenantId = 'tenant-dsh-work'
/** 0002 引导的平台管理员；与 dsh-work 助手的预置负责人一致，不可用时取任一本地平台管理员。 */
const bootstrapAdminId = 'U00008'

export interface SkillCreatorPreset {
  id: string
  name: string
  description: string
  welcomeMessage: string
  examplePrompts: string[]
  testPrompts: string[]
  systemPrompt: string
}

/** 定义随代码发布（Skill 创建专家方案 5.1、5.2）：`preset.json` 与 `SOUL.md`。 */
export function loadSkillCreatorPreset(root: string): SkillCreatorPreset {
  const directory = join(root, 'skill-creator')
  const preset = JSON.parse(readFileSync(join(directory, 'preset.json'), 'utf8')) as Omit<SkillCreatorPreset, 'systemPrompt'>
  return { ...preset, systemPrompt: readFileSync(join(directory, 'SOUL.md'), 'utf8') }
}

export type SkillCreatorSeedResult =
  | { status: 'created'; agentId: string }
  | { status: 'skipped'; reason: 'exists' | 'no_admin' }

/**
 * Skill 创建专家方案 5.1（SKC-05）：环境中还没有开启“可创建 Skill”的 Agent 时，预置一个未发布草稿。
 * 可见角色与岗位角色留空（不可验证、员工不可见），由管理员选定后验证并发布；不预置已发布版本。
 * Agent 不能删除，已有任一开启该开关的版本（含停用、未发布）即视为已有专家，重复启动不会再建。
 */
export async function seedSkillCreatorDraft(
  database: DatabaseClient,
  agents: Pick<PostgresAgentService, 'createAgent'>,
  validation: Pick<PostgresAgentValidationService, 'replaceTestCases'>,
  preset: SkillCreatorPreset,
): Promise<SkillCreatorSeedResult> {
  const [existing] = await database<{ id: string }[]>`
    select a.id from agents a
     where a.tenant_id = ${tenantId}
       and (a.id = ${preset.id} or exists (
         select 1 from agent_versions v
          where v.tenant_id = a.tenant_id and v.agent_id = a.id and v.skill_creation_enabled
       ))
     limit 1
  `
  if (existing) return { status: 'skipped', reason: 'exists' }
  const [admin] = await database<{ id: string }[]>`
    select u.id from users u
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id and ur.source_key = 'local'
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
     where u.tenant_id = ${tenantId} and u.status = 'active'
       and (ur.valid_until is null or ur.valid_until > now())
       and (r.permissions ? 'admin:*' or r.permissions ? 'admin:write')
     order by (u.id = ${bootstrapAdminId}) desc, u.created_at, u.id
     limit 1
  `
  if (!admin) return { status: 'skipped', reason: 'no_admin' }
  await agents.createAgent({
    id: preset.id,
    name: preset.name,
    description: preset.description,
    owner: '',
    department: '',
    welcomeMessage: preset.welcomeMessage,
    examplePrompts: preset.examplePrompts,
    systemPrompt: preset.systemPrompt,
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    skillCreationEnabled: true,
    mcpScope: { mode: 'none', connectorIds: [] },
    changeSummary: '平台预置的 Skill 创建专家草稿',
    actor: admin.id,
  })
  await validation.replaceTestCases(preset.id, admin.id, preset.testPrompts)
  return { status: 'created', agentId: preset.id }
}
