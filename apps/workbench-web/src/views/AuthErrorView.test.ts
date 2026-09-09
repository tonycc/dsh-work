import ElementPlus from 'element-plus'
import { createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import AuthErrorView from './AuthErrorView.vue'

const route = vi.hoisted(() => ({ query: { code: 'business_user_required' } }))
vi.mock('vue-router', () => ({ useRoute: () => route }))

afterEach(() => vi.restoreAllMocks())

function render(code: string) {
  route.query.code = code
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  const wrapper = mount(AuthErrorView, {
    global: { plugins: [createPinia(), ElementPlus] },
  })
  return { wrapper, assign }
}

describe('authentication error recovery', () => {
  it('explains platform account rejection and forces application reauthentication to switch accounts', async () => {
    const { wrapper, assign } = render('business_user_required')
    expect(wrapper.text()).toContain('当前账号无法访问')
    expect(wrapper.text()).toContain('请切换为业务员工账号')
    expect(wrapper.text()).toContain('完成后返回当前应用')
    expect(wrapper.get('button').text()).toBe('切换账号')
    await wrapper.get('button').trigger('click')
    expect(assign).toHaveBeenCalledWith('/auth/workbench/switch-account?return_to=%2Fworkbench')
    wrapper.unmount()
  })

  it('directs business users without permissions to an administrator', () => {
    const { wrapper } = render('permission_denied')
    expect(wrapper.text()).toContain('请联系 dsh-work 管理员授权')
    expect(wrapper.text()).not.toContain('平台管理账号')
    wrapper.unmount()
  })

  it('retries transient errors through its own portal login', async () => {
    const { wrapper, assign } = render('invalid_state')
    expect(wrapper.text()).toContain('登录会话已过期')
    expect(wrapper.get('button').text()).toBe('重新登录')
    await wrapper.get('button').trigger('click')
    expect(assign).toHaveBeenCalledWith('/auth/workbench/login?return_to=%2Fworkbench')
    wrapper.unmount()
  })
})
