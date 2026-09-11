import { describe, expect, it } from 'vitest'

import { formatActivityTime, formatActivityTimeShort } from './activity-time'

/** 以本地时间构造，避免断言依赖运行机器的时区。 */
const now = new Date(2026, 8, 10, 12, 0, 0)

describe('历史会话活动时间格式', () => {
  it('近 7 天用相对时间，更早回落为日期', () => {
    expect(formatActivityTime(new Date(2026, 8, 10, 11, 59, 30).toISOString(), now)).toBe('刚刚')
    expect(formatActivityTime(new Date(2026, 8, 10, 11, 30, 0).toISOString(), now)).toBe('30 分钟前')
    expect(formatActivityTime(new Date(2026, 8, 10, 9, 0, 0).toISOString(), now)).toBe('3 小时前')
    expect(formatActivityTime(new Date(2026, 8, 8, 12, 0, 0).toISOString(), now)).toBe('2 天前')
    expect(formatActivityTime(new Date(2026, 7, 15, 12, 0, 0).toISOString(), now)).toBe('2026-08-15')
  })

  it('小屏短格式：当天时分、当年月日、跨年完整日期', () => {
    expect(formatActivityTimeShort(new Date(2026, 8, 10, 14, 20, 0).toISOString(), now)).toBe('14:20')
    expect(formatActivityTimeShort(new Date(2026, 8, 3, 9, 0, 0).toISOString(), now)).toBe('09-03')
    expect(formatActivityTimeShort(new Date(2025, 8, 3, 9, 0, 0).toISOString(), now)).toBe('2025-09-03')
  })

  it('无法解析时原样返回，不伪造时间', () => {
    expect(formatActivityTime('不是时间', now)).toBe('不是时间')
    expect(formatActivityTimeShort('不是时间', now)).toBe('不是时间')
  })
})
