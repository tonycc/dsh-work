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
})
