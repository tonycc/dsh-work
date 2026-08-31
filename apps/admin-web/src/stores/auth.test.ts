import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('../api/client', () => ({ adminApi: api }))

describe('admin auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.getSession.mockResolvedValue({
      user: {
        id: 'U00008', name: '平台管理员', title: '管理员', department: '数字化中心',
        avatarText: '管', role: 'platform_admin', dataScopes: ['平台配置'],
      },
    })
  })

  it('derives write visibility from the active management role', async () => {
    const { useAuthStore } = await import('./auth')
    const store = useAuthStore()
    await store.load()
    expect(store.canManage).toBe(true)
    expect(store.user.id).toBe('U00008')

    store.switchRole('auditor')
    expect(store.isAuditor).toBe(true)
    expect(store.canManage).toBe(false)
    expect(store.user.role).toBe('auditor')
  })
})
