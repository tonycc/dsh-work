import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminApiError, adminApi } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('admin API client', () => {
  it('keeps permission failure details returned by the management API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'permission_denied',
        message: '当前账号不是平台管理员',
        object: 'Runtime runtime-local-01',
        suggestion: '切换到平台管理员账号后重试。',
        traceId: 'trace-admin-001',
      },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })))

    const error = await adminApi.getRuntimes().catch(cause => cause)
    expect(error).toBeInstanceOf(AdminApiError)
    expect(error).toMatchObject({
      status: 403,
      code: 'permission_denied',
      object: 'Runtime runtime-local-01',
      traceId: 'trace-admin-001',
    })
  })

  it('writes employee role assignments to the dsh-work identity API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'user-1', roles: [] },
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await adminApi.grantIdentityRole('user/1', { roleId: 'role-employee' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/v1/identity/users/user%2F1/roles',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ roleId: 'role-employee' }),
      }),
    )
  })

  it('uses server-side filters and pagination for the employee directory', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        items: [], total: 0, page: 2, pageSize: 20,
        summary: { synchronized: 0, active: 0, authorized: 0 },
      },
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await adminApi.getIdentityUsers({ query: '张 三', status: 'active', page: 2, pageSize: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/v1/identity/users?query=%E5%BC%A0+%E4%B8%89&status=active&page=2&page_size=20',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
