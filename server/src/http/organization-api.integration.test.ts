import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'

import type { ApiAudience, RequestIdentity } from '../modules/identity/types.ts'
import { loadIdentityConfiguration } from '../modules/identity/config.ts'
import { LocalAuthService } from '../modules/identity/local-auth-service.ts'
import { PostgresOrganizationService, type OrganizationSnapshot } from '../modules/organization/postgres-organization-service.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { registerOrganizationRoutes } from './admin/organization-routes.ts'
import { Router } from './router.ts'

// ORG-01～ORG-04（e2e/catalog/organization.md，企业组织架构方案 ORG-S1）：部门树维护与约束、
// 成员与主部门、新建账号选择部门、上线清空历史部门文本、AI Hub 登录模式下不可用。

const tenantId = 'tenant-dsh-work'
const base = '/api/admin/v1/organization'
const password = 'Initial12345'

let database: ThrowawayDatabase
let auth: LocalAuthService
let server: Server
let baseUrl = ''
let adminId = ''
let unavailableBaseUrl = ''
let unavailableServer: Server

function identity(userId: string, audience: ApiAudience, permissions: string[]): RequestIdentity {
  return {
    audience, applicationId: 'organization-test', sessionHash: `session-${userId}`, userId, subject: userId,
    profile: { id: userId, name: userId, title: '管理员', department: '', avatarText: '管', role: 'platform_admin', dataScopes: [] },
    roleIds: [], permissions, dataScopes: [], authorizationVersion: 1, identityProvider: 'local-password',
  }
}

/** 默认以平台管理员（写权限）访问；x-test-readonly 模拟只有读取权限的管理员。 */
function authenticator(request: import('node:http').IncomingMessage, audience: ApiAudience): Promise<RequestIdentity> {
  const readonly = request.headers['x-test-readonly'] === '1'
  return Promise.resolve(identity(adminId, audience, readonly ? ['admin:read'] : ['admin:*', 'admin:read', 'admin:write']))
}

async function listen(router: Router) {
  const created = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => { created.once('error', reject); created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  assert.ok(address && typeof address !== 'string')
  return { server: created, url: `http://127.0.0.1:${address.port}` }
}

async function api(method: string, path: string, options: { body?: unknown; readonly?: boolean; url?: string } = {}) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.readonly) headers['x-test-readonly'] = '1'
  const init: RequestInit = { method, headers }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${options.url ?? baseUrl}${path}`, init)
  const body = await response.json().catch(() => null) as { data?: OrganizationSnapshot; error?: { code: string; message: string } }
  return { status: response.status, body }
}

async function ok(method: string, path: string, body?: unknown): Promise<OrganizationSnapshot> {
  const result = await api(method, path, body === undefined ? {} : { body })
  assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.body)}`)
  return result.body.data!
}

async function snapshot() { return ok('GET', base) }

function root(view: OrganizationSnapshot) {
  const found = view.departments.find(department => department.parentId === null)
  assert.ok(found, '应有根部门')
  return found
}

function departmentNamed(view: OrganizationSnapshot, name: string, parentId?: string) {
  const found = view.departments.find(department => department.name === name && (parentId === undefined || department.parentId === parentId))
  assert.ok(found, `应有部门 ${name}`)
  return found
}

async function createDepartment(parentId: string, name: string) {
  return departmentNamed(await ok('POST', `${base}/departments`, { parentId, name }), name, parentId)
}

async function createEmployee(name: string) {
  const suffix = Math.random().toString(16).slice(2, 10)
  return (await auth.createAccount({ username: `org.${suffix}@example.invalid`, password, name }, adminId)).userId
}

async function displayDepartment(userId: string) {
  const [row] = await database.client<{ department: string | null }[]>`
    select department_id as department from users where tenant_id = ${tenantId} and id = ${userId}
  `
  return row?.department ?? null
}

function membershipsOf(view: OrganizationSnapshot, userId: string) {
  return view.members.filter(member => member.userId === userId)
}

before(async () => {
  database = await createThrowawayDatabase({ namePrefix: 'dsh_work_organization_test', maxConnections: 6 })
  const config = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'organization-integration-secret-32-characters',
    DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  })
  assert.equal(config.mode, 'local')
  auth = new LocalAuthService(config, database.client)
  adminId = (await auth.bootstrap({ username: 'org.admin@example.invalid', name: '组织管理员', password })).userId

  const router = new Router({ authenticateApi: authenticator })
  registerOrganizationRoutes(router, new PostgresOrganizationService(database.client, { available: true }))
  ;({ server, url: baseUrl } = await listen(router))

  const oidcRouter = new Router({ authenticateApi: authenticator })
  registerOrganizationRoutes(oidcRouter, new PostgresOrganizationService(database.client, { available: false }))
  ;({ server: unavailableServer, url: unavailableBaseUrl } = await listen(oidcRouter))
})

after(async () => {
  for (const running of [server, unavailableServer]) {
    if (running?.listening) await new Promise<void>((resolve, reject) => running.close(error => error ? reject(error) : resolve()))
  }
  await database.dispose()
})

test('ORG-03 迁移创建唯一根部门并清空历史部门文本；初始化管理员不写部门文本', async () => {
  const [tenant] = await database.client<{ name: string }[]>`select name from tenants where id = ${tenantId}`
  const roots = await database.client`select id from org_departments where tenant_id = ${tenantId} and parent_id is null`
  assert.equal(roots.length, 1)
  const view = await snapshot()
  assert.equal(view.available, true)
  assert.equal(root(view).name, tenant!.name)
  const auditBefore = await database.client`select 1 from audit_events where action like 'organization.%'`
  await snapshot()
  const auditAfter = await database.client`select 1 from audit_events where action like 'organization.%'`
  assert.equal(auditAfter.length, auditBefore.length, '读取组织架构不写入数据')

  const seeded = await database.client<{ count: number }[]>`
    select count(*)::integer as count from users where tenant_id = ${tenantId} and department_id is not null
  `
  assert.equal(seeded[0]!.count, 0, '上线迁移后不保留任何历史部门文本')
  assert.equal(await displayDepartment(adminId), null)
})

test('ORG-01 部门树：新建、重名、改名、排序、移动子树与删除约束', async () => {
  const rootId = root(await snapshot()).id
  const sales = await createDepartment(rootId, '销售部')
  const east = await createDepartment(sales.id, '华东销售部')
  const team = await createDepartment(east.id, '一组')
  const finance = await createDepartment(rootId, '财务部')

  const duplicate = await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '  销售部 ' } })
  assert.equal(duplicate.status, 409)
  await createDepartment(finance.id, '一组')
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '  ' } })).status, 422)
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: rootId, name: '长'.repeat(61) } })).status, 422)
  assert.equal((await api('POST', `${base}/departments`, { body: { parentId: 'dept-missing', name: '无上级' } })).status, 404)

  let view = await ok('PATCH', `${base}/departments/${sales.id}`, { name: '销售中心' })
  assert.equal(departmentNamed(view, '销售中心').id, sales.id)

  view = await ok('POST', `${base}/departments/${finance.id}/reorder`, { direction: 'up' })
  const order = view.departments.filter(department => department.parentId === rootId).sort((a, b) => a.sortOrder - b.sortOrder).map(department => department.name)
  assert.deepEqual(order.slice(0, 2), ['财务部', '销售中心'])
  assert.equal((await api('POST', `${base}/departments/${finance.id}/reorder`, { body: { direction: 'sideways' } })).status, 422)

  view = await ok('PATCH', `${base}/departments/${east.id}`, { parentId: finance.id })
  assert.equal(view.departments.find(department => department.id === east.id)!.parentId, finance.id)
  assert.equal(view.departments.find(department => department.id === team.id)!.parentId, east.id, '下级部门随之移动')
  const [paths] = await database.client<{ path: string }[]>`select path from org_departments where id = ${team.id}`
  assert.equal(paths!.path, `/${rootId}/${finance.id}/${east.id}/${team.id}/`)

  assert.equal((await api('PATCH', `${base}/departments/${finance.id}`, { body: { parentId: team.id } })).status, 409, '不能移到自己的下级之下')
  assert.equal((await api('PATCH', `${base}/departments/${finance.id}`, { body: { parentId: finance.id } })).status, 409)
  assert.equal((await api('PATCH', `${base}/departments/${rootId}`, { body: { parentId: finance.id } })).status, 409, '根部门不能移动')
  assert.equal((await api('DELETE', `${base}/departments/${rootId}`)).status, 409, '根部门不能删除')
  await ok('PATCH', `${base}/departments/${rootId}`, { name: '示例企业（改名）' })

  const renamedMove = await createDepartment(rootId, '财务部（待合并）')
  await createDepartment(finance.id, '财务部（待合并）')
  view = await ok('PATCH', `${base}/departments/${renamedMove.id}`, { parentId: finance.id, name: '资金组' })
  const moved = view.departments.find(department => department.id === renamedMove.id)!
  assert.deepEqual([moved.parentId, moved.name], [finance.id, '资金组'], '同时移动和改名时按新名称检查重名')
  assert.equal((await api('PATCH', `${base}/departments/${renamedMove.id}`, { body: { parentId: rootId, name: '销售中心' } })).status, 409)

  const blocked = await api('DELETE', `${base}/departments/${east.id}`)
  assert.equal(blocked.status, 409)
  assert.match(blocked.body.error!.message, /下级部门/)
  const member = await createEmployee('删除拦截员工')
  await ok('POST', `${base}/departments/${team.id}/members`, { userIds: [member] })
  const withMember = await api('DELETE', `${base}/departments/${team.id}`)
  assert.equal(withMember.status, 409)
  assert.match(withMember.body.error!.message, /成员/)
  await api('DELETE', `${base}/departments/${team.id}/members/${member}`)
  view = await ok('DELETE', `${base}/departments/${team.id}`)
  assert.equal(view.departments.some(department => department.id === team.id), false)
  await createDepartment(east.id, '一组')

  const audits = await database.client<{ action: string }[]>`
    select action from audit_events where actor_id = ${adminId} and action like 'organization.department.%'
  `
  for (const action of ['create', 'update', 'reorder', 'remove']) {
    assert.ok(audits.some(row => row.action === `organization.department.${action}`), `应有 ${action} 审计`)
  }
})

test('ORG-01 只读管理员可以读取但不能写入；并发移动不会形成环', async () => {
  const rootId = root(await snapshot()).id
  assert.equal((await api('GET', base, { readonly: true })).status, 200)
  assert.equal((await api('POST', `${base}/departments`, { readonly: true, body: { parentId: rootId, name: '只读新建' } })).status, 403)

  const left = await createDepartment(rootId, '并发甲')
  const right = await createDepartment(rootId, '并发乙')
  const results = await Promise.all([
    api('PATCH', `${base}/departments/${left.id}`, { body: { parentId: right.id } }),
    api('PATCH', `${base}/departments/${right.id}`, { body: { parentId: left.id } }),
  ])
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
  const rows = await database.client<{ id: string; path: string }[]>`
    select id, path from org_departments where id in ${database.client([left.id, right.id])}
  `
  for (const row of rows) {
    assert.equal(row.path.split('/').filter(Boolean).filter(id => id === row.id).length, 1, '路径中不出现自己两次')
    assert.ok(row.path.startsWith(`/${rootId}/`), '仍挂在根部门之下')
  }
})

test('ORG-02 成员：多选加入、主部门、显示部门与移出主部门', async () => {
  const rootId = root(await snapshot()).id
  const supply = await createDepartment(rootId, '供应链中心')
  const buy = await createDepartment(supply.id, '采购部')
  const alice = await createEmployee('甲员工')
  const bob = await createEmployee('乙员工')
  const disabled = await createEmployee('停用员工')
  await auth.setStatus(disabled, 'disabled', adminId)

  let view = await ok('POST', `${base}/departments/${supply.id}/members`, { userIds: [alice, bob, alice] })
  assert.deepEqual(membershipsOf(view, alice), [{ departmentId: supply.id, userId: alice, primary: true }])
  assert.equal(await displayDepartment(alice), '供应链中心')
  assert.ok(view.employees.some(employee => employee.id === alice && employee.status === 'active'))
  await ok('POST', `${base}/departments/${supply.id}/members`, { userIds: [alice] })

  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: [disabled] } })).status, 422)
  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: ['U-missing'] } })).status, 422)
  assert.equal((await api('POST', `${base}/departments/${supply.id}/members`, { body: { userIds: [] } })).status, 422)

  view = await ok('POST', `${base}/departments/${buy.id}/members`, { userIds: [alice] })
  assert.deepEqual(membershipsOf(view, alice).filter(member => member.primary).map(member => member.departmentId), [supply.id], '已有主部门的员工保持原主部门')

  view = await ok('PUT', `${base}/departments/${buy.id}/members/${alice}/primary`)
  assert.deepEqual(membershipsOf(view, alice).filter(member => member.primary).map(member => member.departmentId), [buy.id])
  assert.equal(await displayDepartment(alice), '采购部')
  await ok('PATCH', `${base}/departments/${buy.id}`, { name: '采购管理部' })
  assert.equal(await displayDepartment(alice), '采购管理部', '主部门改名后显示部门同步更新')

  const missingPrimary = await api('DELETE', `${base}/departments/${buy.id}/members/${alice}`)
  assert.equal(missingPrimary.status, 422)
  const wrongPrimary = await api('DELETE', `${base}/departments/${buy.id}/members/${alice}?new_primary_department_id=${rootId}`)
  assert.equal(wrongPrimary.status, 422)
  view = await ok('DELETE', `${base}/departments/${buy.id}/members/${alice}?new_primary_department_id=${supply.id}`)
  assert.deepEqual(membershipsOf(view, alice), [{ departmentId: supply.id, userId: alice, primary: true }])
  assert.equal(await displayDepartment(alice), '供应链中心')

  view = await ok('DELETE', `${base}/departments/${supply.id}/members/${bob}`)
  assert.deepEqual(membershipsOf(view, bob), [])
  assert.equal(await displayDepartment(bob), null, '移出唯一部门后变为未分配')
  assert.equal((await api('DELETE', `${base}/departments/${supply.id}/members/${bob}`)).status, 404)
  assert.equal((await api('PUT', `${base}/departments/${buy.id}/members/${bob}/primary`)).status, 404)

  const [primaries] = await database.client<{ count: number }[]>`
    select count(*)::integer as count from (
      select user_id from org_department_members where tenant_id = ${tenantId} and is_primary group by user_id having count(*) > 1
    ) duplicated
  `
  assert.equal(primaries!.count, 0, '每名员工至多一个主部门')
})

test('ORG-03 新建账号从部门树选择部门；不接受自由填写的部门文字', async () => {
  const rootId = root(await snapshot()).id
  const hr = await createDepartment(rootId, '人力资源部')
  const created = await auth.createAccount({ username: 'org.new.hire@example.invalid', password, name: '新入职员工', departmentId: hr.id }, adminId)
  const view = await snapshot()
  assert.deepEqual(membershipsOf(view, created.userId), [{ departmentId: hr.id, userId: created.userId, primary: true }])
  assert.equal(await displayDepartment(created.userId), '人力资源部')

  const legacy = await auth.createAccount({ username: 'org.legacy@example.invalid', password, name: '旧字段员工', department: '自填部门' } as never, adminId)
  assert.equal(await displayDepartment(legacy.userId), null, '自由填写的部门文字被忽略')

  await assert.rejects(
    auth.createAccount({ username: 'org.bad.dept@example.invalid', password, name: '错误部门员工', departmentId: 'dept-missing' }, adminId),
    (error: { code?: string }) => error.code === 'resource_not_found',
  )
  const [orphan] = await database.client`
    select 1 from local_user_credentials where tenant_id = ${tenantId} and username = 'org.bad.dept@example.invalid'
  `
  assert.equal(orphan, undefined, '部门无效时不创建账号')
})

test('ORG-04 AI Hub 登录模式下组织架构不可用，写操作不落库', async () => {
  const oidcConfig = loadIdentityConfiguration({
    DSH_WORK_AUTH_MODE: 'local', DSH_WORK_SESSION_SECRET: 'organization-integration-secret-32-characters',
    DSH_WORK_WORKBENCH_ORIGINS: 'http://localhost:4174', DSH_WORK_ADMIN_ORIGINS: 'http://localhost:4180',
  })
  assert.equal(oidcConfig.mode, 'local')
  const oidcAuth = new LocalAuthService(oidcConfig, database.client, { organizationAvailable: false })
  const department = root(await snapshot())
  await assert.rejects(
    oidcAuth.createAccount({ username: 'org.oidc.dept@example.invalid', password, name: 'AI Hub 模式员工', departmentId: department.id }, adminId),
    (error: { code?: string }) => error.code === 'organization_unavailable',
  )
  const [created] = await database.client`
    select 1 from local_user_credentials where tenant_id = ${tenantId} and username = 'org.oidc.dept@example.invalid'
  `
  assert.equal(created, undefined, 'AI Hub 模式下带部门建号被拒绝，不创建账号')

  const view = (await api('GET', base, { url: unavailableBaseUrl })).body.data!
  assert.deepEqual(view, { available: false, departments: [], members: [], employees: [] })
  const rootId = root(await snapshot()).id
  const [before] = await database.client<{ count: number }[]>`select count(*)::integer as count from org_departments`
  const rejected = await api('POST', `${base}/departments`, { url: unavailableBaseUrl, body: { parentId: rootId, name: '不可用模式部门' } })
  assert.equal(rejected.status, 409)
  const [afterwards] = await database.client<{ count: number }[]>`select count(*)::integer as count from org_departments`
  assert.equal(afterwards!.count, before!.count)
})
