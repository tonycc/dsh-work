import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'

import RolePermissionEditor from './RolePermissionEditor.vue'

function render(props: { modelValue: string[]; actorPermissions: string[]; locked?: boolean; platformRole?: boolean }) {
  return mount(RolePermissionEditor, {
    props: { locked: false, platformRole: false, ...props },
    global: { plugins: [ElementPlus] },
  })
}

describe('RolePermissionEditor', () => {
  it('groups permissions by module and converts legacy all-module codes when a module changes', async () => {
    const wrapper = render({ modelValue: ['admin:read', 'workbench:use'], actorPermissions: ['admin:*'] })
    expect(wrapper.findAll('section').map(section => section.attributes('aria-label'))).toEqual(expect.arrayContaining(['企业知识库', '员工与权限', '钉钉集成', '审计', '员工工作台']))
    const knowledge = wrapper.find('section[aria-label="企业知识库"]')
    await knowledge.findAll('input[type="checkbox"]')[1]!.setValue(true)
    const emitted = wrapper.emitted('update:modelValue')!.at(-1)![0] as string[]
    expect(emitted).toContain('admin:knowledge:write')
    expect(emitted).toContain('admin:agent:read')
    expect(emitted).not.toContain('admin:read')
    expect(emitted).toContain('workbench:use')
  })

  it('disables options beyond the actor and hides templates it cannot grant', () => {
    const wrapper = render({ modelValue: [], actorPermissions: ['admin:identity:write', 'workbench:use'] })
    const agent = wrapper.find('section[aria-label="Agent"]')
    expect(agent.findAll('input[type="checkbox"]').every(input => (input.element as HTMLInputElement).disabled)).toBe(true)
    expect(agent.text()).toContain('超出你的权限')
    const identity = wrapper.find('section[aria-label="员工与权限"]')
    expect(identity.findAll('input[type="checkbox"]').some(input => !(input.element as HTMLInputElement).disabled)).toBe(true)
    expect(wrapper.text()).not.toContain('知识库管理员')
  })

  it('locks every option for the platform administrator role', () => {
    const wrapper = render({ modelValue: ['admin:*'], actorPermissions: ['admin:*'], platformRole: true })
    expect(wrapper.text()).toContain('只能修改名称')
    expect(wrapper.findAll('input').every(input => (input.element as HTMLInputElement).disabled)).toBe(true)
  })
})
