import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { adminApi } from '@/api/client'
import { provideAgentDraftEditor, type AgentDraftEditor } from '@/composables/use-agent-draft'
import AgentCapabilitySection from './AgentCapabilitySection.vue'

// RP-E2E-06（e2e/catalog/admin-platform.md）：Agent 运行超时大于接受调度的 Runtime 中最短的单次执行超时时提示实际生效值。
beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => vi.restoreAllMocks())

function mountSection() {
  let editor!: AgentDraftEditor
  const Host = defineComponent({
    setup() {
      editor = provideAgentDraftEditor(ref(undefined), { canEdit: ref(false) })
      return () => h(AgentCapabilitySection)
    },
  })
  const wrapper = mount(Host, { global: { plugins: [ElementPlus], stubs: { teleport: true, ElSelect: true, ElOption: true } } })
  return { wrapper, editor: () => editor }
}

it('提示实际生效的运行超时：大于 Runtime 单次执行超时时提示，不大于时不提示', async () => {
  const limits = vi.spyOn(adminApi, 'getRuntimeLimits').mockResolvedValue([
    // 运行可能落到任一接受调度的 Runtime：按最短的提示。
    { id: 'runtime-02', name: '备用 Runtime', timeoutSeconds: 900 },
    { id: 'runtime-local-01', name: '本地 Runtime', timeoutSeconds: 180 },
  ])
  const { wrapper, editor } = mountSection()
  try {
    await flushPromises()
    expect(limits).toHaveBeenCalledOnce()
    const hint = wrapper.get('[data-testid="agent-effective-timeout"]')
    expect(hint.text()).toContain('实际生效 180 秒')
    expect(hint.text()).toContain('本地 Runtime')
    editor().form.timeoutSeconds = 180
    await nextTick()
    expect(wrapper.find('[data-testid="agent-effective-timeout"]').exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

it('读不到 Runtime 超时（例如没有权限）时不提示，也不报错', async () => {
  vi.spyOn(adminApi, 'getRuntimeLimits').mockRejectedValue(new Error('forbidden'))
  const { wrapper } = mountSection()
  try {
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-effective-timeout"]').exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})
