import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillDefinition, SkillReleaseRecord, SkillVersionRecord } from '../types/domain'

const api = vi.hoisted(() => ({
  getAgentReleaseRecords: vi.fn(),
  getAgents: vi.fn(),
  getAgentVersions: vi.fn(),
  getAuditEvents: vi.fn(),
  getConnectors: vi.fn(),
  getHealth: vi.fn(),
  getModelUsage: vi.fn(),
  getOperationsSummary: vi.fn(),
  getPlatformStatus: vi.fn(),
  getRuntimes: vi.fn(),
  getSession: vi.fn(),
  getSessions: vi.fn(),
  getSkillReleaseRecords: vi.fn(),
  getSkills: vi.fn(),
  getSkillVersions: vi.fn(),
  getTasks: vi.fn(),
  getTools: vi.fn(),
  getUsage: vi.fn(),
  getWorkspaces: vi.fn(),
  rollbackSkill: vi.fn(),
  setSkillStatus: vi.fn(),
}))
vi.mock('../api/client', () => ({ adminApi: api }))

describe('admin content store Skill version state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('marks the published draft in version history without a page reload', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    const release = makeRelease({ action: 'published', version: '0.2.0' })
    store.$patch({
      skills: [makeSkill({ version: '0.2.0', activeVersion: '0.1.0', status: 'draft' })],
      skillVersions: [makeVersion({ version: '0.2.0', status: 'draft' })],
    })
    api.setSkillStatus.mockResolvedValue({
      skill: makeSkill({ version: '0.2.0', activeVersion: '0.2.0', status: 'published' }),
      release,
    })

    await store.setSkillStatus('skill-reporting', 'published')

    expect(store.skillVersions[0]).toMatchObject({
      status: 'published',
      publishedAt: release.time,
      publishedBy: release.actor,
    })
    expect(store.skillReleaseRecords).toEqual([release])
  })

  it('disables the discarded draft in version history after rollback', async () => {
    const { useContentStore } = await import('./content')
    const store = useContentStore()
    const release = makeRelease({ action: 'rollback', version: '0.1.0' })
    store.$patch({
      skills: [makeSkill({ version: '0.2.0', activeVersion: '0.1.0', status: 'draft' })],
      skillVersions: [
        makeVersion({ id: 'skill-version-draft', version: '0.2.0', status: 'draft' }),
        makeVersion({ id: 'skill-version-target', version: '0.1.0', status: 'published' }),
      ],
    })
    api.rollbackSkill.mockResolvedValue({
      skill: makeSkill({ version: '0.1.0', activeVersion: '0.1.0', status: 'published' }),
      release,
    })

    await store.rollbackSkill('skill-reporting', '0.1.0')

    expect(store.skillVersions.find(item => item.id === 'skill-version-draft')?.status).toBe('disabled')
    expect(store.skillVersions.find(item => item.id === 'skill-version-target')?.status).toBe('published')
    expect(store.skillReleaseRecords).toEqual([release])
  })

  it('loads only audit endpoints for an audit-only session', async () => {
    const { useAuthStore } = await import('./auth')
    const { useContentStore } = await import('./content')
    const authStore = useAuthStore()
    api.getSession.mockResolvedValue({
      identityProvider: 'ai-hub-oidc',
      apiAudience: 'admin',
      permissions: ['audit:read'],
      user: {
        id: 'U00019', name: '安全审计员', title: '审计员', department: '信息安全部',
        avatarText: '审', role: 'auditor', dataScopes: [],
      },
    })
    await authStore.load()
    api.getAuditEvents.mockResolvedValue([])
    api.getOperationsSummary.mockResolvedValue({
      runs24h: 0,
      modelTokens24h: 0,
      attentionEvents24h: 0,
    })

    const store = useContentStore()
    await store.load()

    expect(api.getAuditEvents).toHaveBeenCalledOnce()
    expect(api.getOperationsSummary).toHaveBeenCalledOnce()
    expect(api.getTasks).not.toHaveBeenCalled()
    expect(api.getAgents).not.toHaveBeenCalled()
  })
})

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'skill-reporting',
    name: '报告生成',
    version: '0.1.0',
    activeVersion: '0.1.0',
    category: '写作',
    owner: '平台管理员',
    status: 'published',
    description: '生成结构化业务报告。',
    instructions: '根据用户输入生成结构化业务报告，并标记数据来源。',
    toolIds: ['tool-read'],
    testPrompt: '生成本周业务报告',
    updatedAt: '2026-08-31 10:00',
    ...overrides,
  }
}

function makeVersion(overrides: Partial<SkillVersionRecord> = {}): SkillVersionRecord {
  return {
    id: 'skill-version-reporting-1',
    skillId: 'skill-reporting',
    version: '0.1.0',
    name: '报告生成',
    category: '写作',
    description: '生成结构化业务报告。',
    instructions: '根据用户输入生成结构化业务报告，并标记数据来源。',
    toolIds: ['tool-read'],
    testPrompt: '生成本周业务报告',
    status: 'published',
    createdAt: '2026-08-31 09:00',
    createdBy: '平台管理员',
    summary: 'Skill 版本',
    ...overrides,
  }
}

function makeRelease(overrides: Partial<SkillReleaseRecord> = {}): SkillReleaseRecord {
  return {
    id: 'skill-release-reporting-1',
    skillId: 'skill-reporting',
    version: '0.1.0',
    action: 'published',
    actor: '平台管理员',
    time: '2026-08-31 10:30',
    note: 'Skill 状态变更',
    ...overrides,
  }
}
