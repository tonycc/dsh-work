import { describe, expect, it } from 'vitest'

import type { UserNotification } from '@/types/domain'
import { notificationLocation, notificationPlainText } from './notifications'

function notification(overrides: Partial<UserNotification>): UserNotification {
  return {
    id: 'n', kind: 'mention', createdAt: new Date().toISOString(), read: false, visible: true,
    actor: null, workspace: null, objectName: null, detail: null, target: null, ...overrides,
  }
}

describe('notification text and destination (NC-S3)', () => {
  it('describes a paused or stopped schedule with its reason and opens the task', () => {
    const paused = notification({
      kind: 'task_schedule_stopped', objectName: '每日舆情汇总', workspace: { id: 'ws-1', name: '品牌舆情监测' },
      detail: { state: 'paused', reason: 'consecutive_failures' }, target: { type: 'project_task', id: 'ptask-1', sessionId: null },
    })
    expect(notificationPlainText(paused)).toBe('任务 「每日舆情汇总」 的定时执行已暂停：连续多次执行失败')
    expect(notificationLocation(paused, 'work')).toEqual({ name: 'workspace-task', params: { id: 'ws-1', taskId: 'ptask-1' } })
    expect(notificationPlainText({ ...paused, detail: { state: 'stopped', reason: 'workspace_archived' } }))
      .toBe('任务 「每日舆情汇总」 的定时执行已停止：项目已归档')
  })

  it('names how a scheduled automation run did not succeed and opens its conversation', () => {
    const failed = notification({
      kind: 'automation_failed', objectName: '周一销售周报', workspace: { id: 'ws-personal', name: '我的空间' },
      detail: { outcome: 'failed' }, target: { type: 'automation', id: 'auto-1', sessionId: 'session-9' },
    })
    expect(notificationPlainText(failed)).toBe('定时任务 「周一销售周报」 本次执行失败')
    expect(notificationLocation(failed, 'collab')).toEqual({ name: 'session-detail', params: { id: 'session-9' } })
    for (const [outcome, text] of [['skipped', '本次执行被跳过'], ['missed', '因服务停机错过了执行'], ['interrupted', '本次执行未能开始']]) {
      expect(notificationPlainText({ ...failed, detail: { outcome: outcome! } })).toContain(text!)
    }
    // 没有对话（错过、未能开始）时打开定时任务页。
    expect(notificationLocation({ ...failed, target: { type: 'automation', id: 'auto-1', sessionId: null } }, 'work')).toEqual({ path: '/automations' })
  })

  it('reports a Skill review result without the reason and opens the submitting conversation', () => {
    const approved = notification({
      kind: 'skill_review_result', objectName: '销售周报整理', actor: { id: 'admin', name: '管理员' },
      detail: { result: 'approved' }, target: { type: 'skill_submission', id: 'sub-1', sessionId: 'session-3' },
    })
    expect(notificationPlainText(approved)).toBe('你提交的 Skill 「销售周报整理」 已发布到 Skill 广场')
    expect(notificationPlainText({ ...approved, detail: { result: 'rejected' } })).toBe('你提交的 Skill 「销售周报整理」 未通过审核，原因见草稿卡片')
    expect(notificationLocation(approved, 'work')).toEqual({ name: 'session-detail', params: { id: 'session-3' } })
  })

  it('has no destination once the content is no longer visible', () => {
    expect(notificationLocation(notification({ kind: 'automation_failed', visible: false }), 'work')).toBeNull()
  })
})
