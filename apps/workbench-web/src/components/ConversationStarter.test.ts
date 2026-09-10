import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { WorkspaceFile } from '@/types/domain'
import ConversationStarter from './ConversationStarter.vue'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => ({ query: {} }) }))

describe('ConversationStarter', () => {
  it('does not submit a previously referenced workspace file after switching tasks', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-supply',
        workspaceName: '供应链空间',
        workspaceLocked: true,
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    const file: WorkspaceFile = {
      id: 'file-sensitive',
      name: '敏感库存.xlsx',
      type: 'XLSX',
      size: '12 KB',
      uploadedBy: '林岚',
      uploadedAt: '刚刚',
    }

    const exposed = wrapper.vm as unknown as { useWorkspaceFile: (value: WorkspaceFile) => void }
    exposed.useWorkspaceFile(file)
    await flushPromises()
    const reportTask = wrapper.findAll<HTMLButtonElement>('.capability-chip')
      .find(button => button.text().includes('生成报告'))
    expect(reportTask).toBeDefined()
    await reportTask?.trigger('click')
    await flushPromises()

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '生成经营报告',
      files: [],
      workspaceId: 'ws-supply',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '生成经营报告',
      [],
      'ws-supply',
      '供应链空间',
      undefined,
      [],
      undefined,
      undefined,
    )
  })

  it('passes the selected team Agent member when starting a conversation (TW-02)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: {
        workspaceId: 'ws-team',
        workspaceName: '供应链团队',
        workspaceLocked: true,
        presetAgentMember: { id: 'wam-001', name: '订单分析助手', status: 'available' },
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)

    expect(wrapper.find('[data-testid="preset-agent-member"]').text()).toContain('订单分析助手')

    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '分析订单波动',
      files: [],
      workspaceId: 'ws-team',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '分析订单波动',
      [],
      'ws-team',
      '供应链团队',
      undefined,
      [],
      undefined,
      'wam-001',
    )
  })

  it('does not send a team Agent member id for personal conversations (AC-23)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(ConversationStarter, {
      props: { presetAgentMember: { id: 'wam-001', name: '订单分析助手', status: 'available' } },
      global: { plugins: [pinia, ElementPlus] },
    })
    const taskStore = useTaskStore(pinia)
    const createTask = vi.spyOn(taskStore, 'createTask').mockResolvedValue({ id: 'run-test' } as never)
    // 个人空间未锁定，需等内容 Store 完成加载后才渲染输入区。
    const contentStore = useContentStore(pinia)
    vi.spyOn(contentStore, 'load').mockResolvedValue(undefined)
    vi.spyOn(contentStore, 'refreshSkills').mockResolvedValue([])
    contentStore.initialized = true

    await flushPromises()
    wrapper.findComponent(TaskComposer).vm.$emit('submit', {
      prompt: '整理个人材料',
      files: [],
      workspaceId: 'ws-personal',
    })
    await flushPromises()

    expect(createTask).toHaveBeenCalledWith(
      '整理个人材料',
      [],
      'ws-personal',
      '我的空间',
      undefined,
      [],
      undefined,
      undefined,
    )
  })
})
