import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import { TaskComposer } from '@dsh-work/workbench-components'
import { useTaskStore } from '@/stores/tasks'
import type { WorkspaceFile } from '@/types/domain'
import ConversationStarter from './ConversationStarter.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('vue-router', () => ({ useRouter: () => router }))

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
    )
  })
})
