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

  it('searches agent candidates with query, cursor and limit as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        items: [{
          agentId: 'agent-1', name: '订单分析助手', description: '分析订单数据',
          activeVersionId: 'agent-version-agent-1-1-0-0', activeVersion: '1.0.0', status: 'published',
        }],
        nextCursor: 'next',
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await workbenchApi.listWorkspaceAgentCandidates('ws/team-1', { query: '订单', cursor: 'cur-1', limit: 10 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/agent-candidates?query=%E8%AE%A2%E5%8D%95&cursor=cur-1&limit=10',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(page.items[0]).toMatchObject({ agentId: 'agent-1', name: '订单分析助手' })
    expect(page.nextCursor).toBe('next')
  })

  it('lists team workspace sessions with query, cursor and limit as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        items: [{
          sessionId: 'session-1',
          title: '季度复盘',
          creatorId: 'user-1',
          creatorName: '林岚',
          lastActiveAt: '2026-09-10T08:00:00.000Z',
          runCount: 3,
          latestRun: { id: 'run/3', status: 'running' },
        }],
        nextCursor: 'next',
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await workbenchApi.listWorkspaceSessions('ws/team-1', { query: '复盘', cursor: 'cur-1', limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/sessions?query=%E5%A4%8D%E7%9B%98&cursor=cur-1&limit=20',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(page.items[0]).toMatchObject({ sessionId: 'session-1', title: '季度复盘', runCount: 3 })
    expect(page.items[0]?.latestRun).toEqual({ id: 'run/3', status: 'running' })
    expect(page.nextCursor).toBe('next')
  })

  it('omits the team session query string entirely when no filters are given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await workbenchApi.listWorkspaceSessions('ws-team-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/sessions',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(page).toEqual({ items: [], nextCursor: null })
  })

  it('serializes the session scope when provided (team probe)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.listWorkspaceSessions('ws-team-1', { scope: 'team', limit: 1 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/sessions?limit=1&scope=team',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('lists workspace agent members through the agent-members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 'wam-1', agentId: 'agent-1', name: '订单分析助手', description: '分析订单数据',
        status: 'available', version: '1.0.0', addedBy: 'user-a',
        createdAt: '2026-09-09T10:00:00.000Z',
        allowedActions: ['start_conversation', 'disable', 'upgrade', 'remove'],
      }],
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const members = await workbenchApi.listWorkspaceAgentMembers('ws-team-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/agent-members', expect.objectContaining({
      method: 'GET',
    }))
    expect(members[0]).toMatchObject({ id: 'wam-1', agentId: 'agent-1', status: 'available' })
  })

  it('adds a workspace agent member through the agent-members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'wam-1', agentId: 'agent/1', name: '订单分析助手', description: '分析订单数据',
        status: 'available', version: '1.0.0', addedBy: 'user-a',
        createdAt: '2026-09-09T10:00:00.000Z', allowedActions: [],
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.addWorkspaceAgentMember('ws-team-1', { agentId: 'agent/1' })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/agent-members', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent/1' }),
    }))
  })

  it('updates a workspace agent member through the agent-members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'wam/1', agentId: 'agent-1', name: '订单分析助手', description: '分析订单数据',
        status: 'disabled', version: '1.0.0', addedBy: 'user-a',
        createdAt: '2026-09-09T10:00:00.000Z', allowedActions: ['enable', 'upgrade', 'remove'],
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.updateWorkspaceAgentMember('ws-team-1', 'wam/1', { action: 'disable' })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/agent-members/wam%2F1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ action: 'disable' }),
    }))
  })

  it('removes a workspace agent member through the agent-members endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'wam-1', removed: true },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await workbenchApi.removeWorkspaceAgentMember('ws-team-1', 'wam-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws-team-1/agent-members/wam-1', expect.objectContaining({
      method: 'DELETE',
    }))
    expect(result).toEqual({ id: 'wam-1', removed: true })
  })
})
