import { randomUUID } from 'node:crypto'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { requirePlatformAdminActor } from '../authorization/platform-admin-actor.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'

const tenantId = 'tenant-dsh-work'
const maxNameLength = 60
const maxMembersPerRequest = 200

export interface OrganizationDepartment {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
}

export interface OrganizationMember {
  departmentId: string
  userId: string
  primary: boolean
}

export interface OrganizationEmployee {
  id: string
  name: string
  email: string | null
  loginAccount: string | null
  status: 'active' | 'disabled'
}

export interface OrganizationSnapshot {
  available: boolean
  departments: OrganizationDepartment[]
  members: OrganizationMember[]
  employees: OrganizationEmployee[]
}

interface DepartmentRow {
  id: string
  parentId: string | null
  name: string
  path: string
}

/**
 * 企业组织架构 ORG-S1（docs/design/org-structure-plan.md）：本地维护的部门树、成员与主部门。
 * 部门本身不带权限；按部门授权是第二期（ORG-S2）。所有写操作只有平台管理员可以执行，按企业
 * 串行（事务级咨询锁），在同一事务中同步员工的显示部门（users.department_id = 主部门名称）并写审计。
 * AI Hub（OIDC）登录模式下组织架构不可用（方案 OD1）。
 */
export class PostgresOrganizationService {
  private readonly database: DatabaseClient

  private readonly available: boolean

  constructor(database: DatabaseClient, options: { available: boolean }) {
    this.database = database
    this.available = options.available
  }

  async snapshot(): Promise<OrganizationSnapshot> {
    if (!this.available) return { available: false, departments: [], members: [], employees: [] }
    return readSnapshot(this.database)
  }

  async createDepartment(input: { parentId: unknown; name: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const parent = await requireDepartment(transaction, text(input.parentId, '上级部门'))
      const name = departmentName(input.name)
      await assertSiblingNameFree(transaction, parent.id, name)
      const id = `dept-${randomUUID()}`
      await transaction`
        insert into org_departments (id, tenant_id, parent_id, name, path, sort_order, updated_by)
        values (
          ${id}, ${tenantId}, ${parent.id}, ${name}, ${`${parent.path}${id}/`},
          (select coalesce(max(sort_order) + 1, 0) from org_departments
            where tenant_id = ${tenantId} and parent_id = ${parent.id} and status = 'active'),
          ${input.actorId}
        )
      `
      return { action: 'organization.department.create', objectId: id, context: { parentId: parent.id } }
    })
  }

  async updateDepartment(input: { departmentId: string; name?: unknown; parentId?: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      const changed: string[] = []
      // 同时移动和改名时，按改名后的名称检查新上级下是否重名。
      const finalName = input.name !== undefined ? departmentName(input.name) : department.name
      const renamed = finalName !== department.name
      if (input.parentId !== undefined && input.parentId !== department.parentId) {
        if (!department.parentId) throw stateConflict('根部门不能移动')
        const target = await requireDepartment(transaction, text(input.parentId, '上级部门'))
        if (target.path.startsWith(department.path)) throw stateConflict('不能移动到本部门自己或它的下级部门之下')
        await assertSiblingNameFree(transaction, target.id, finalName, department.id)
        const newPath = `${target.path}${department.id}/`
        await transaction`
          update org_departments
             set path = ${newPath} || substr(path, ${department.path.length + 1}), updated_at = now()
           where tenant_id = ${tenantId} and left(path, ${department.path.length}) = ${department.path}
        `
        await transaction`
          update org_departments
             set parent_id = ${target.id}, name = ${finalName}, updated_by = ${input.actorId},
                 sort_order = (select coalesce(max(sort_order) + 1, 0) from org_departments
                                where tenant_id = ${tenantId} and parent_id = ${target.id} and status = 'active')
           where tenant_id = ${tenantId} and id = ${department.id}
        `
        changed.push('parent')
      } else if (renamed) {
        if (department.parentId) await assertSiblingNameFree(transaction, department.parentId, finalName, department.id)
        await transaction`
          update org_departments set name = ${finalName}, updated_at = now(), updated_by = ${input.actorId}
           where tenant_id = ${tenantId} and id = ${department.id}
        `
      }
      // 移动时名称与上级在同一条语句中写入，避免先以旧名挂到新上级下触发同级重名约束。
      if (renamed) {
        await transaction`
          update users u set department_id = ${finalName}, updated_at = now()
            from org_department_members m
           where m.tenant_id = ${tenantId} and m.department_id = ${department.id} and m.is_primary
             and u.tenant_id = m.tenant_id and u.id = m.user_id
        `
        changed.push('name')
      }
      return { action: 'organization.department.update', objectId: department.id, context: { changed } }
    })
  }

  async reorderDepartment(input: { departmentId: string; direction: unknown; actorId: string }) {
    if (input.direction !== 'up' && input.direction !== 'down') throw invalidRequest('direction 必须为 up 或 down')
    const direction = input.direction
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      if (!department.parentId) throw stateConflict('根部门不能调整顺序')
      const siblings = await transaction<{ id: string }[]>`
        select id from org_departments
         where tenant_id = ${tenantId} and parent_id = ${department.parentId} and status = 'active'
         order by sort_order, name, id
      `
      const index = siblings.findIndex(sibling => sibling.id === department.id)
      const swapWith = direction === 'up' ? index - 1 : index + 1
      if (swapWith >= 0 && swapWith < siblings.length) {
        const order = siblings.map(sibling => sibling.id)
        ;[order[index], order[swapWith]] = [order[swapWith]!, order[index]!]
        for (const [position, id] of order.entries()) {
          await transaction`update org_departments set sort_order = ${position} where tenant_id = ${tenantId} and id = ${id}`
        }
      }
      return { action: 'organization.department.reorder', objectId: department.id, context: { direction } }
    })
  }

  async removeDepartment(input: { departmentId: string; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      if (!department.parentId) throw stateConflict('根部门不能删除')
      const [usage] = await transaction<{ children: number; members: number }[]>`
        select (select count(*)::integer from org_departments
                 where tenant_id = ${tenantId} and parent_id = ${department.id} and status = 'active') as children,
               (select count(*)::integer from org_department_members
                 where tenant_id = ${tenantId} and department_id = ${department.id}) as members
      `
      const reasons = [
        usage!.children ? `还有 ${usage!.children} 个下级部门` : '',
        usage!.members ? `还有 ${usage!.members} 名成员` : '',
      ].filter(Boolean)
      if (reasons.length) throw stateConflict(`不能删除“${department.name}”：${reasons.join('，')}`)
      await transaction`
        update org_departments set status = 'removed', updated_at = now(), updated_by = ${input.actorId}
         where tenant_id = ${tenantId} and id = ${department.id}
      `
      return { action: 'organization.department.remove', objectId: department.id, context: {} }
    })
  }

  async addMembers(input: { departmentId: string; userIds: unknown; actorId: string }) {
    if (!Array.isArray(input.userIds) || input.userIds.length === 0 || input.userIds.length > maxMembersPerRequest
      || input.userIds.some(id => typeof id !== 'string' || !id)) {
      throw invalidRequest(`userIds 必须为 1–${maxMembersPerRequest} 个员工 ID`)
    }
    const userIds = [...new Set(input.userIds as string[])]
    return this.write(input.actorId, async (transaction) => {
      const department = await requireDepartment(transaction, input.departmentId)
      const valid = await transaction<{ id: string }[]>`
        select u.id from users u
         where u.tenant_id = ${tenantId} and u.id in ${transaction(userIds)} and u.status = 'active' and u.business_user
           and (u.identity_provider = 'ai-hub'
                or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id))
      `
      if (valid.length !== userIds.length) throw invalidRequest('包含不存在或已停用的员工')
      for (const userId of userIds) await addMembership(transaction, department.id, userId, input.actorId)
      return { action: 'organization.member.add', objectId: department.id, context: { userIds } }
    })
  }

  async removeMember(input: { departmentId: string; userId: string; newPrimaryDepartmentId?: unknown; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const memberships = await transaction<{ departmentId: string; primary: boolean }[]>`
        select m.department_id as "departmentId", m.is_primary as primary
          from org_department_members m
         where m.tenant_id = ${tenantId} and m.user_id = ${input.userId}
      `
      const removed = memberships.find(membership => membership.departmentId === input.departmentId)
      if (!removed) throw notFound('该员工不在这个部门中')
      const others = memberships.filter(membership => membership.departmentId !== input.departmentId)
      let newPrimary: string | null = null
      if (removed.primary && others.length) {
        newPrimary = typeof input.newPrimaryDepartmentId === 'string' ? input.newPrimaryDepartmentId : null
        if (!newPrimary || !others.some(membership => membership.departmentId === newPrimary)) {
          throw invalidRequest('本部门是该员工的主部门，请从其所属的其他部门中指定新的主部门')
        }
      }
      await transaction`
        delete from org_department_members
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      if (newPrimary) {
        await transaction`
          update org_department_members set is_primary = true
           where tenant_id = ${tenantId} and department_id = ${newPrimary} and user_id = ${input.userId}
        `
      }
      await syncDisplayDepartment(transaction, input.userId)
      return { action: 'organization.member.remove', objectId: input.departmentId, context: { userId: input.userId, newPrimary } }
    })
  }

  async setPrimaryDepartment(input: { departmentId: string; userId: string; actorId: string }) {
    return this.write(input.actorId, async (transaction) => {
      const [membership] = await transaction`
        select 1 from org_department_members
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      if (!membership) throw notFound('该员工不在这个部门中')
      await transaction`
        update org_department_members set is_primary = false
         where tenant_id = ${tenantId} and user_id = ${input.userId} and is_primary
      `
      await transaction`
        update org_department_members set is_primary = true
         where tenant_id = ${tenantId} and department_id = ${input.departmentId} and user_id = ${input.userId}
      `
      await syncDisplayDepartment(transaction, input.userId)
      return { action: 'organization.member.primary', objectId: input.departmentId, context: { userId: input.userId } }
    })
  }

  private async write(
    actorId: string,
    change: (transaction: DatabaseTransaction) => Promise<{ action: string; objectId: string; context: Record<string, unknown> }>,
  ): Promise<OrganizationSnapshot> {
    if (!this.available) throw stateConflict('当前为 AI Hub 登录模式，组织架构不可用')
    return this.database.begin(async (transaction) => {
      await requirePlatformAdminActor(transaction, actorId)
      await lockOrganization(transaction)
      const audit = await change(transaction)
      await appendOrganizationAudit(transaction, { actorId, ...audit })
      return readSnapshot(transaction)
    })
  }
}

/**
 * 新建账号时把员工放入一个部门并设为主部门（方案第 5 节“员工账号”），与建号同一事务。
 * 只校验部门有效；操作人是否为平台管理员由建号流程负责。
 */
export async function assignNewAccountDepartment(
  transaction: DatabaseTransaction,
  input: { userId: string; departmentId: unknown; actorId: string },
) {
  if (typeof input.departmentId !== 'string' || !input.departmentId) throw invalidRequest('部门无效')
  await lockOrganization(transaction)
  const department = await requireDepartment(transaction, input.departmentId)
  await addMembership(transaction, department.id, input.userId, input.actorId)
}

async function readSnapshot(sql: DatabaseClient | DatabaseTransaction): Promise<OrganizationSnapshot> {
  const departments = await sql<OrganizationDepartment[]>`
    select id, parent_id as "parentId", name, sort_order as "sortOrder"
      from org_departments
     where tenant_id = ${tenantId} and status = 'active'
     order by path = '/' || id || '/' desc, sort_order, name, id
  `
  const members = await sql<OrganizationMember[]>`
    select m.department_id as "departmentId", m.user_id as "userId", m.is_primary as primary
      from org_department_members m
      join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id and d.status = 'active'
     where m.tenant_id = ${tenantId}
     order by m.user_id, m.department_id
  `
  const employees = await sql<OrganizationEmployee[]>`
    select u.id, u.display_name as name, u.email, u.status,
           coalesce(
             (select c.username from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id),
             case when u.identity_provider = 'ai-hub' then u.external_subject end
           ) as "loginAccount"
      from users u
     where u.tenant_id = ${tenantId} and u.business_user
       and (u.identity_provider = 'ai-hub'
            or exists (select 1 from local_user_credentials c where c.tenant_id = u.tenant_id and c.user_id = u.id))
     order by u.display_name, u.id
  `
  return { available: true, departments, members, employees }
}

/** 树的写操作按企业串行，避免两次并发移动绕过“不能移到自己下级之下”的检查而形成环。 */
async function lockOrganization(transaction: DatabaseTransaction) {
  await transaction`select pg_advisory_xact_lock(hashtext(${`org-departments:${tenantId}`}))`
}

async function requireDepartment(transaction: DatabaseTransaction, departmentId: string): Promise<DepartmentRow> {
  const [department] = await transaction<DepartmentRow[]>`
    select id, parent_id as "parentId", name, path
      from org_departments
     where tenant_id = ${tenantId} and id = ${departmentId} and status = 'active'
  `
  if (!department) throw notFound('部门不存在或已删除')
  return department
}

async function assertSiblingNameFree(transaction: DatabaseTransaction, parentId: string, name: string, exceptId = '') {
  const [clash] = await transaction`
    select 1 from org_departments
     where tenant_id = ${tenantId} and parent_id = ${parentId} and status = 'active' and name = ${name} and id <> ${exceptId}
  `
  if (clash) throw stateConflict('同一上级部门下已有同名部门')
}

/** 加入部门；还没有主部门的员工以该部门为主部门。重复加入幂等。 */
async function addMembership(transaction: DatabaseTransaction, departmentId: string, userId: string, actorId: string) {
  await transaction`
    insert into org_department_members (tenant_id, department_id, user_id, is_primary, added_by)
    values (
      ${tenantId}, ${departmentId}, ${userId},
      not exists (select 1 from org_department_members where tenant_id = ${tenantId} and user_id = ${userId} and is_primary),
      ${actorId}
    )
    on conflict (tenant_id, department_id, user_id) do nothing
  `
  await syncDisplayDepartment(transaction, userId)
}

/** 显示部门 = 主部门名称；没有主部门时为空（页面显示“未分配部门”）。 */
async function syncDisplayDepartment(transaction: DatabaseTransaction, userId: string) {
  await transaction`
    update users u
       set department_id = (
             select d.name from org_department_members m
               join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id
              where m.tenant_id = u.tenant_id and m.user_id = u.id and m.is_primary
           ),
           updated_at = now()
     where u.tenant_id = ${tenantId} and u.id = ${userId}
  `
}

async function appendOrganizationAudit(
  transaction: DatabaseTransaction,
  input: { actorId: string; action: string; objectId: string; context: Record<string, unknown> },
) {
  await transaction`
    insert into audit_events (
      id, tenant_id, actor_type, actor_id, action, object_type,
      object_id, result, trace_id, safe_context
    ) values (
      ${`audit-${randomUUID()}`}, ${tenantId}, 'user', ${input.actorId},
      ${input.action}, 'org_department', ${input.objectId}, 'success',
      ${`trace-organization-${randomUUID()}`},
      ${transaction.json({ audience: 'admin', ...input.context })}
    )
  `
}

function text(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw invalidRequest(`${label}不能为空`)
  return value.trim()
}

function departmentName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw invalidRequest('请输入部门名称')
  const name = value.trim()
  if ([...name].length > maxNameLength) throw invalidRequest(`部门名称不能超过 ${maxNameLength} 个字符`)
  return name
}
