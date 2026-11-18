import { randomUUID } from 'node:crypto'

import type { SkillArtifactStore } from '../../modules/skill/skill-artifact-store.ts'
import { createSkillPackage } from '../../modules/skill/skill-package.ts'
import type { DatabaseClient } from './database.ts'

const tenantId = 'tenant-dsh-work'

export interface SkillDraftFixtureInput {
  name: string
  category?: string
  description: string
  instructions: string
  toolIds: string[]
  testPrompt: string
  actor: string
  /** 为已有 Skill 追加草稿版本时传入，须同时给出 version。 */
  skillId?: string
  version?: string
}

/**
 * 测试夹具：直接写入一个非安装来源的 Skill 草稿版本，正文以文件夹制品保存。
 * 产品中没有对应入口（文本创建/更新接口已删除，Skill 只经安装或员工提交进入）；
 * 发布、回滚、引用类套件借此准备数据，安装链路本身见 admin-skill-installation 集成套件。
 */
export async function insertSkillDraft(
  database: DatabaseClient,
  artifactStore: SkillArtifactStore,
  input: SkillDraftFixtureInput,
): Promise<{ skillId: string; versionId: string; version: string }> {
  if (input.skillId && !input.version) throw new Error('为已有 Skill 追加草稿时须给出 version')
  const skillId = input.skillId ?? `skill-${randomUUID().slice(0, 12)}`
  const version = input.version ?? '0.1.0'
  const versionId = `skill-version-${randomUUID()}`
  const category = input.category ?? '测试'
  const artifact = await artifactStore.put(createSkillPackage({
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    version,
    toolIds: input.toolIds,
  }))
  await database.begin(async transaction => {
    if (!input.skillId) {
      await transaction`
        insert into skills (id, tenant_id, key, name, category, description, owner_user_id, created_by, status, draft_version_id)
        values (${skillId}, ${tenantId}, ${skillId}, ${input.name}, ${category}, ${input.description}, ${input.actor}, ${input.actor}, 'draft', null)
      `
    }
    await transaction`
      insert into skill_versions (
        id, tenant_id, skill_id, version, name, category, description, instructions,
        manifest, artifact_ref, package_sha256, tool_refs, test_prompt, status, created_by, change_summary
      ) values (
        ${versionId}, ${tenantId}, ${skillId}, ${version}, ${input.name}, ${category}, ${input.description}, '',
        ${transaction.json(JSON.parse(JSON.stringify({ artifact })))}, ${artifact.artifactRef}, ${artifact.sha256},
        ${transaction.json(input.toolIds)}, ${input.testPrompt}, 'draft', ${input.actor}, ${`测试夹具写入 ${version} 草稿`}
      )
    `
    await transaction`
      update skills set name = ${input.name}, category = ${category}, description = ${input.description},
                        draft_version_id = ${versionId}, updated_at = now()
       where tenant_id = ${tenantId} and id = ${skillId}
    `
  })
  return { skillId, versionId, version }
}
