import { describe, expect, it } from 'vitest'

import type { Workspace } from '@/types/domain'
import { isTaskInArchivedWorkspace } from './archived-workspaces'

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: '供应链团队',
    description: '',
    type: 'team',
    memberCount: 1,
    sessionCount: 0,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

describe('isTaskInArchivedWorkspace', () => {
  it('detects a task in an archived team workspace (session delete is execution track)', () => {
    const archived = workspace({ id: 'ws-archived', status: 'archived', archivedAt: '2026-09-11T00:00:00.000Z' })
    expect(isTaskInArchivedWorkspace({ workspaceId: 'ws-archived' }, [archived])).toBe(true)
  })

  it('keeps active team and personal workspaces deletable (AC-23)', () => {
    const active = workspace({ id: 'ws-active' })
    const personal = workspace({ id: 'ws-personal', type: 'personal' })
    expect(isTaskInArchivedWorkspace({ workspaceId: 'ws-active' }, [active, personal])).toBe(false)
    expect(isTaskInArchivedWorkspace({ workspaceId: 'ws-personal' }, [active, personal])).toBe(false)
  })

  it('does not disable deletion when the workspace is not loaded yet', () => {
    // 列表尚未加载时不能误禁用：宁可让服务端拒绝，也不隐藏可用动作。
    expect(isTaskInArchivedWorkspace({ workspaceId: 'ws-unknown' }, [])).toBe(false)
  })
})
