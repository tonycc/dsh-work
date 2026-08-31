import type { CreateSkillInput, PublishStatus, UpdateSkillInput } from '../../domain/types.ts'
import type { PostgresSkillService } from '../../modules/skill/postgres-skill-service.ts'
import { envelope, httpResult, readJsonBody, type Router } from '../router.ts'

const basePath = '/api/admin/v1'

export function registerSkillRoutes(router: Router, service: PostgresSkillService) {
  router.get(`${basePath}/skills`, async () => envelope('admin', await service.getSkills(), 'postgres'))
  router.get(`${basePath}/skill-versions`, async () => envelope('admin', await service.getSkillVersions(), 'postgres'))
  router.get(`${basePath}/skill-release-records`, async () => envelope('admin', await service.getReleaseRecords(), 'postgres'))
  router.post(`${basePath}/skills`, async request => httpResult(
    201,
    envelope('admin', await service.createSkill(await readJsonBody<CreateSkillInput>(request)), 'postgres'),
  ))
  router.patch(`${basePath}/skills`, async request => envelope(
    'admin',
    await service.updateSkill(await readJsonBody<UpdateSkillInput>(request)),
    'postgres',
  ))
  router.post(`${basePath}/skills/test`, async request => envelope(
    'admin',
    await service.testSkill(await readJsonBody<{ skillId: string; prompt?: string; actor: string }>(request)),
    'postgres',
  ))
  router.patch(`${basePath}/skills/status`, async request => envelope(
    'admin',
    await service.setStatus(await readJsonBody<{
      skillId: string
      status: Extract<PublishStatus, 'published' | 'disabled'>
      actor: string
    }>(request)),
    'postgres',
  ))
  router.post(`${basePath}/skills/rollback`, async request => envelope(
    'admin',
    await service.rollback(await readJsonBody<{ skillId: string; version: string; actor: string }>(request)),
    'postgres',
  ))
}
