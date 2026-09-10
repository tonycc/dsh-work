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

  it('searches member candidates with query, cursor and limit as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [{ id: 'user-1', displayName: '张伟', department: '供应链中心' }], nextCursor: 'next' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await workbenchApi.listMemberCandidates('ws/team-1', { query: '张伟', cursor: 'cur-1', limit: 10 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/member-candidates?query=%E5%BC%A0%E4%BC%9F&cursor=cur-1&limit=10',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(page.items[0]).toMatchObject({ id: 'user-1', displayName: '张伟' })
    expect(page.nextCursor).toBe('next')
  })

  it('adds a workspace member through the members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { userId: 'user-1', displayName: '张伟', role: 'member', joinedAt: '2026-09-09T10:00:00.000Z' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.addWorkspaceMember('ws-team-1', { userId: 'user-1', role: 'member' })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/members', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ userId: 'user-1', role: 'member' }),
    }))
  })

  it('changes a member role through the members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { userId: 'user/1', displayName: '张伟', role: 'admin', joinedAt: '2026-09-09T10:00:00.000Z' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.updateMemberRole('ws-team-1', 'user/1', { role: 'admin' })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/members/user%2F1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    }))
  })

  it('removes a workspace member through the members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { userId: 'user-1', removed: true },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await workbenchApi.removeWorkspaceMember('ws-team-1', 'user-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/members/user-1', expect.objectContaining({
      method: 'DELETE',
    }))
    expect(result).toEqual({ userId: 'user-1', removed: true })
  })

  it('exits a workspace through the exit endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { workspaceId: 'ws-team-1', exited: true },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.exitWorkspace('ws-team-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/exit', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('transfers workspace ownership through the owner-transfer endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { workspaceId: 'ws-team-1', previousOwnerId: 'user-a', newOwnerId: 'user-b' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.transferWorkspaceOwner('ws-team-1', { toUserId: 'user-b' })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/owner-transfer', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ toUserId: 'user-b' }),
    }))
  })
})
