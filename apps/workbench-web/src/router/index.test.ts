import { describe, expect, it } from 'vitest'

import router from './index'

describe('workbench authentication routes', () => {
  it('serves login errors outside the backend auth proxy', () => {
    const route = router.resolve('/login-error')

    expect(route.name).toBe('auth-error')
    expect(route.meta.public).toBe(true)
  })
})
