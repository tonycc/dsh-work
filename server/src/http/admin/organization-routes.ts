import type { PostgresOrganizationService } from '../../modules/organization/postgres-organization-service.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/admin/v1/organization'

type OrganizationStore = Pick<
  PostgresOrganizationService,
  'snapshot' | 'createDepartment' | 'updateDepartment' | 'reorderDepartment' | 'removeDepartment'
  | 'addMembers' | 'removeMember' | 'setPrimaryDepartment'
>

/**
 * 组织架构 ORG-S1：部门树、成员与主部门。读取返回整棵树与员工清单（企业内部门与员工规模小），
 * 写操作返回更新后的同一结构，页面直接替换。只有平台管理员可以写；AI Hub 登录模式下不可用。
 */
export function registerOrganizationRoutes(
  router: Router,
  organization: OrganizationStore,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  const actor = (context: Parameters<typeof requireRequestIdentity>[0]) => requireRequestIdentity(context, 'admin').userId

  router.get(basePath, async () => envelope('admin', await organization.snapshot(), adapter))

  router.post(`${basePath}/departments`, async (request, context) => {
    const input = await readJsonBody<{ parentId?: unknown; name?: unknown }>(request)
    return envelope('admin', await organization.createDepartment({ parentId: input.parentId, name: input.name, actorId: actor(context) }), adapter)
  })

  router.patch(`${basePath}/departments/:departmentId`, async (request, context) => {
    const input = await readJsonBody<{ parentId?: unknown; name?: unknown }>(request)
    return envelope('admin', await organization.updateDepartment({
      departmentId: context.params.departmentId ?? '',
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      actorId: actor(context),
    }), adapter)
  })

  router.post(`${basePath}/departments/:departmentId/reorder`, async (request, context) => {
    const input = await readJsonBody<{ direction?: unknown }>(request)
    return envelope('admin', await organization.reorderDepartment({
      departmentId: context.params.departmentId ?? '', direction: input.direction, actorId: actor(context),
    }), adapter)
  })

  router.delete(`${basePath}/departments/:departmentId`, async (_request, context) => envelope('admin', await organization.removeDepartment({
    departmentId: context.params.departmentId ?? '', actorId: actor(context),
  }), adapter))

  router.post(`${basePath}/departments/:departmentId/members`, async (request, context) => {
    const input = await readJsonBody<{ userIds?: unknown }>(request)
    return envelope('admin', await organization.addMembers({
      departmentId: context.params.departmentId ?? '', userIds: input.userIds, actorId: actor(context),
    }), adapter)
  })

  router.delete(`${basePath}/departments/:departmentId/members/:userId`, async (_request, context) => envelope('admin', await organization.removeMember({
    departmentId: context.params.departmentId ?? '',
    userId: context.params.userId ?? '',
    newPrimaryDepartmentId: context.url.searchParams.get('new_primary_department_id') ?? undefined,
    actorId: actor(context),
  }), adapter))

  router.put(`${basePath}/departments/:departmentId/members/:userId/primary`, async (_request, context) => envelope('admin', await organization.setPrimaryDepartment({
    departmentId: context.params.departmentId ?? '', userId: context.params.userId ?? '', actorId: actor(context),
  }), adapter))
}
