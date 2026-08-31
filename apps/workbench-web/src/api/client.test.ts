import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('workbench API client', () => {
  it('deletes an encoded Session through the conversation endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { sessionId: 'session/001', title: '库存分析', archived: true },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.deleteSession('session/001')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/sessions/session%2F001', expect.objectContaining({
      method: 'DELETE',
    }))
  })

  it('preserves structured server errors for user-facing recovery guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'dependency_unavailable',
        message: '成果存储不可用',
        object: '成果 artifact-001',
        suggestion: '存储恢复后重新下载。',
        traceId: 'trace-download-001',
      },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })))

    const error = await workbenchApi.downloadArtifact('artifact-001', 1).catch(cause => cause)
    expect(error).toBeInstanceOf(WorkbenchApiError)
    expect(error).toMatchObject({
      status: 503,
      code: 'dependency_unavailable',
      object: '成果 artifact-001',
      suggestion: '存储恢复后重新下载。',
      traceId: 'trace-download-001',
    })
  })

  it('returns the binary body only after a successful download response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('artifact-body', { status: 200 })))
    const blob = await workbenchApi.downloadArtifact('artifact-001', 2)
    expect(await blob.text()).toBe('artifact-body')
  })
})
