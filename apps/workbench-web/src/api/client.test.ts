import { afterEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from './client'

afterEach(() => vi.unstubAllGlobals())

/** 是否含未配对的代理半区（UTF-16 层面判定，合法 emoji 成对出现）。 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

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

  it('serializes the session query filters without any scope parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { items: [], nextCursor: null },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.listWorkspaceSessions('ws-team-1', { query: '巡检', limit: 1 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/sessions?query=%E5%B7%A1%E6%A3%80&limit=1',
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

  it('lists workspaces without a query string for the default 全部 filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [],
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.getWorkspaces()

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces', expect.objectContaining({ method: 'GET' }))
  })

  it('serializes the archived workspace filter as ?status=archived', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 'ws-team-1',
        name: '九月复盘',
        description: '',
        type: 'team',
        memberCount: 2,
        sessionCount: 0,
        artifactCount: 0,
        updatedAt: '2026-09-11T00:00:00.000Z',
        owner: '林岚',
        members: ['林岚', '周航'],
        files: [],
        status: 'archived',
        archivedAt: '2026-09-11T00:00:00.000Z',
      }],
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const workspaces = await workbenchApi.getWorkspaces('archived')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces?status=archived',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(workspaces[0]).toMatchObject({ id: 'ws-team-1', status: 'archived' })
  })

  it('archives and restores a team workspace through the lifecycle endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: { id: 'ws/team-1', status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const archived = await workbenchApi.archiveWorkspace('ws/team-1')
    await workbenchApi.restoreWorkspace('ws/team-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws%2Fteam-1/archive', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws%2Fteam-1/restore', expect.objectContaining({
      method: 'POST',
    }))
    expect(archived).toEqual({ id: 'ws/team-1', status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' })
  })

  it('lists team activity with limit and cursor as query parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        workspaceId: 'ws/team-1',
        items: [{
          id: 'wact-1',
          kind: 'member_added',
          actorUserId: 'user-1',
          actorDisplayName: '林岚',
          objectType: 'member',
          objectId: 'user-2',
          safeMetadata: { userId: 'user-2', role: 'member' },
          occurredAt: '2026-09-10T08:00:00.000Z',
        }],
        nextCursor: 'cursor-1',
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await workbenchApi.listWorkspaceActivity('ws/team-1', { cursor: 'cur-1', limit: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/activity?cursor=cur-1&limit=20',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(page.items[0]).toMatchObject({ id: 'wact-1', kind: 'member_added', actorDisplayName: '林岚' })
    expect(page.nextCursor).toBe('cursor-1')
  })

  it('omits the activity query string entirely when no paging is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { workspaceId: 'ws-team-1', items: [], nextCursor: null },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.listWorkspaceActivity('ws-team-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/activity',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('serializes the usage range as a query parameter (TW-09 / 4-T2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        workspaceId: 'ws/team-1',
        range: '30d',
        rangeDays: 30,
        totals: {
          callCount: 12,
          successCount: 10,
          failedCount: 2,
          estimatedCount: 3,
          inputTokens: 12345,
          outputTokens: 6789,
          totalTokens: 19134,
        },
        daily: [{ day: '09-06', callCount: 2, successCount: 2, failedCount: 0, inputTokens: 1000, outputTokens: 500 }],
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await workbenchApi.listWorkspaceUsage('ws/team-1', { range: '30d' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/usage?range=30d',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.rangeDays).toBe(30)
    expect(result.totals).toMatchObject({ callCount: 12, totalTokens: 19134, estimatedCount: 3 })
    expect(result.daily[0]).toMatchObject({ day: '09-06', inputTokens: 1000, outputTokens: 500 })
  })

  it('omits the usage query string entirely when no range is given (server defaults to 7d)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        workspaceId: 'ws-team-1',
        range: '7d',
        rangeDays: 7,
        totals: {
          callCount: 0,
          successCount: 0,
          failedCount: 0,
          estimatedCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        daily: [],
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.listWorkspaceUsage('ws-team-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/usage',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('loads the unread notification page with the reminder state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        workspaceId: 'ws-team-1',
        items: [],
        nextCursor: null,
        muted: true,
        mutedAt: '2026-09-10T08:00:00.000Z',
        lastReadAt: null,
        unreadCount: 0,
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const view = await workbenchApi.getWorkspaceNotifications('ws-team-1', { limit: 1 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws-team-1/notifications?limit=1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(view).toMatchObject({ muted: true, unreadCount: 0 })
  })

  it('marks notifications read and toggles the workspace reminder through POST endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify({
      data: {
        workspaceId: 'ws/team-1',
        muted: String(url).endsWith('/mute'),
        mutedAt: String(url).endsWith('/mute') ? '2026-09-10T08:00:00.000Z' : null,
        lastReadAt: '2026-09-10T08:00:00.000Z',
        unreadCount: 0,
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.markWorkspaceNotificationsRead('ws/team-1')
    const muted = await workbenchApi.muteWorkspaceNotifications('ws/team-1')
    const unmuted = await workbenchApi.unmuteWorkspaceNotifications('ws/team-1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/notifications/read',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/notifications/mute',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/notifications/unmute',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(muted.muted).toBe(true)
    expect(unmuted.muted).toBe(false)
  })

  it('updates workspace name and clears the description with an explicit null through PATCH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'ws/team-1',
        name: '供应链协作空间',
        description: '',
        type: 'team',
        memberCount: 2,
        sessionCount: 0,
        artifactCount: 0,
        updatedAt: '2026-09-11T00:00:00.000Z',
        owner: '林岚',
        members: ['林岚', '周航'],
        files: [],
        status: 'active',
        archivedAt: null,
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.updateWorkspace('ws/team-1', { name: '供应链协作空间', description: null })

    expect(fetchMock).toHaveBeenCalledWith('/api/workbench/v1/workspaces/ws%2Fteam-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ name: '供应链协作空间', description: null }),
    }))
  })

  it('lists every version of a logical file through the encoded versions endpoint', async () => {
    const page = {
      logicalFileId: 'wfile/1',
      name: '库存明细.xlsx',
      status: 'active',
      latestVersionNo: 2,
      versionCount: 2,
      items: [
        {
          versionNo: 2,
          fileId: 'file-2',
          logicalFileId: 'wfile/1',
          name: '库存明细.xlsx',
          type: 'XLSX',
          size: '12 KB',
          note: '补充 9 月数据',
          uploadedBy: '林岚',
          uploadedAt: '2026-09-12 09:00',
          scanStatus: 'clean',
          parseStatus: 'succeeded',
          current: true,
          canDownload: true,
        },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: page,
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await workbenchApi.listWorkspaceFileVersions('ws/team-1', 'wfile/1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/files/wfile%2F1/versions',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result.items[0]).toMatchObject({ versionNo: 2, fileId: 'file-2', current: true })
  })

  it('uploads a new version with an encoded name and note, keeping the file as the binary body', async () => {
    const file = new File(['库存'], '库存明细 9月.xlsx', { type: 'application/vnd.ms-excel' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        id: 'file-3',
        logicalFileId: 'wfile-1',
        versionNo: 3,
        name: '库存明细 9月.xlsx',
        type: 'XLSX',
        size: '8 KB',
        uploadedBy: '林岚',
        uploadedAt: '刚刚',
        extractionStatus: 'succeeded',
      },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const uploaded = await workbenchApi.uploadWorkspaceFileVersion('ws/team-1', 'wfile-1', file, '补充 9 月数据')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/workbench/v1/workspaces/ws%2Fteam-1/files/wfile-1/versions')
    expect(init).toMatchObject({ method: 'POST', body: file })
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/vnd.ms-excel',
      'X-File-Name': encodeURIComponent('库存明细 9月.xlsx'),
      'X-File-Note': encodeURIComponent('补充 9 月数据'),
    })
    expect(uploaded.versionNo).toBe(3)
  })

  it('omits X-File-Note when the update note is empty so the server stores null', async () => {
    const file = new File(['x'], '明细.xlsx', { type: 'application/vnd.ms-excel' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'file-3', logicalFileId: 'wfile-1', versionNo: 2, extractionStatus: 'succeeded' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.uploadWorkspaceFileVersion('ws-team-1', 'wfile-1', file, '   ')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.headers).not.toHaveProperty('X-File-Note')
  })

  it('clamps the update note to 500 characters before sending it', async () => {
    const file = new File(['x'], '明细.xlsx', { type: 'application/vnd.ms-excel' })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'file-3', logicalFileId: 'wfile-1', versionNo: 2, extractionStatus: 'succeeded' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await workbenchApi.uploadWorkspaceFileVersion('ws-team-1', 'wfile-1', file, '更'.repeat(620))

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const sent = decodeURIComponent((init.headers as Record<string, string>)['X-File-Note'] ?? '')
    expect(sent).toHaveLength(500)
  })

  it('按码点截断更新说明：代理对边界不得抛 URIError，且 UTF-16 长度不超过 500', async () => {
    const file = new File(['x'], '明细.xlsx', { type: 'application/vnd.ms-excel' })
    // 每轮都要一个新的 Response：Response body 只能被读取一次。
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      data: { id: 'file-3', logicalFileId: 'wfile-1', versionNo: 2, extractionStatus: 'succeeded' },
      meta: { api: 'workbench', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)

    // 判别设计：`slice(0, 500)` 会把 'a'*499 + '😀' 的代理对劈开，
    // encodeURIComponent 随即抛 URIError: URI malformed（评审 P2 实测）。
    for (const note of ['a'.repeat(499) + '😀', 'a'.repeat(499) + '\uD83D', '😀'.repeat(400)]) {
      fetchMock.mockClear()
      await workbenchApi.uploadWorkspaceFileVersion('ws-team-1', 'wfile-1', file, note)
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const raw = (init.headers as Record<string, string>)['X-File-Note'] ?? ''
      const decoded = decodeURIComponent(raw)
      expect(decoded.length).toBeLessThanOrEqual(500)
      // 不得含任何孤立代理半区（合法的 emoji 以低位代理结尾，因此必须成对判定）。
      expect(hasLoneSurrogate(decoded)).toBe(false)
    }
  })

  it('downloads one historical version through the encoded version download endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('version-body', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const blob = await workbenchApi.downloadWorkspaceFileVersion('ws/team-1', 'wfile/1', 2)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/v1/workspaces/ws%2Fteam-1/files/wfile%2F1/versions/2/download',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(await blob.text()).toBe('version-body')
  })
})
