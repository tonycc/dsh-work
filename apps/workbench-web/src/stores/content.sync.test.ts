import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  getWorkspaces: vi.fn(async () => []),
  getArtifacts: vi.fn(async () => []),
  getAgents: vi.fn(async () => []),
}))
vi.mock('../api/client', () => ({ workbenchApi: api }))

import { useContentStore } from './content'

describe('content store sync', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('页面挂载的 sync 与壳层冷启动 load 合并为一轮请求', async () => {
    const store = useContentStore()
    await Promise.all([store.sync(), store.load()])
    expect(api.getWorkspaces).toHaveBeenCalledTimes(1)
    expect(api.getArtifacts).toHaveBeenCalledTimes(1)
    expect(api.getAgents).toHaveBeenCalledTimes(1)
  })

  it('refresh 总是发起新一轮请求，已初始化后 sync 也重新拉取', async () => {
    const store = useContentStore()
    await store.sync()
    await Promise.all([store.refresh(), store.refresh()])
    await store.sync()
    expect(api.getWorkspaces).toHaveBeenCalledTimes(4)
  })
})
