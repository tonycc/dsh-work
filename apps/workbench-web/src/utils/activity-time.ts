/**
 * 历史会话列表的「最近活动时间」呈现（design §2.2、§4）。
 *
 * - 全量格式：近 7 天用相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前），更早用日期；
 * - 短格式：≤520px 小屏只保留短格式——当天 `HH:mm`、当年 `MM-DD`、跨年 `YYYY-MM-DD`。
 *
 * 只做展示格式化，不做时区换算，也不改变服务端返回的原始 ISO 值。
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function toDate(value: string): Date | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 形如「3 小时前 / 2026-09-01」。无法解析时原样返回，不伪造时间。 */
export function formatActivityTime(value: string, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return value
  const diff = now.getTime() - date.getTime()
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)} 天前`
  return isoDate(date)
}

/** 小屏短格式：`14:20 / 09-03 / 2025-09-03`。 */
export function formatActivityTimeShort(value: string, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return value
  if (date.getFullYear() !== now.getFullYear()) return isoDate(date)
  const sameDay = date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  if (sameDay) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
