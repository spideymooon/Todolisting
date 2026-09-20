/**
 * 本地日历日工具。
 *
 * 时间约定（《00-架构设计》§3.1）：
 * - 时刻类字段（created_at / completed_at / due_at_utc）存 ISO UTC 字符串
 * - due_date 存「本地日历日」`YYYY-MM-DD`，避免时区换算把日期错位一天
 *
 * 本文件是纯函数，主进程与渲染进程共用。
 */

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'] as const

/** Date → 本地日历日 `YYYY-MM-DD` */
export function toDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** `YYYY-MM-DD` → 本地零点 Date */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function todayKey(now: Date = new Date()): string {
  return toDateKey(now)
}

/** 按「日历日」加减，自动跨月跨年 */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  r.setDate(r.getDate() + n)
  return r
}

export function offsetKey(now: Date, n: number): string {
  return toDateKey(addDays(now, n))
}

/** toKey - fromKey 的天数差（正数表示 toKey 在未来） */
export function diffDays(fromKey: string, toKey: string): number {
  const a = fromDateKey(fromKey).getTime()
  const b = fromDateKey(toKey).getTime()
  return Math.round((b - a) / 86_400_000)
}

/** 0=周日 … 6=周六 */
export function weekdayIndex(key: string): number {
  return fromDateKey(key).getDay()
}

export function weekdayCn(key: string): string {
  return WEEK_CN[weekdayIndex(key)]
}

export function formatMonthDay(key: string): string {
  const d = fromDateKey(key)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function formatFullDate(key: string): string {
  const d = fromDateKey(key)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEK_CN[d.getDay()]}`
}

/**
 * 页面副标题用的日期：「2026年9月18日 · 周五」（《UI优化》§5）。
 * 中间加间隔号是为了让日期与星期形成两级阅读节奏，
 * 而任务编辑器里的 formatFullDate 保持紧凑原样即可。
 */
export function formatFullDateDotted(key: string): string {
  const d = fromDateKey(key)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 周${WEEK_CN[d.getDay()]}`
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'normal'

/** 卡片右上角的到期警示（《01-UI设计规范》§5.4） */
export function dueLabel(dueKey: string, now: Date = new Date()): { text: string; tone: DueTone } {
  const delta = diffDays(todayKey(now), dueKey)
  if (delta < 0) return { text: `已逾期${-delta}天`, tone: 'overdue' }
  if (delta === 0) return { text: '今天', tone: 'today' }
  if (delta === 1) return { text: '明天', tone: 'soon' }
  if (delta === 2) return { text: '后天', tone: 'soon' }
  if (delta <= 7) return { text: `周${weekdayCn(dueKey)}`, tone: 'normal' }
  return { text: formatMonthDay(dueKey), tone: 'normal' }
}

/** 卡片元信息行里的短标签 */
export function shortDueLabel(dueKey: string, now: Date = new Date()): string {
  const delta = diffDays(todayKey(now), dueKey)
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === 2) return '后天'
  if (delta === -1) return '昨天'
  return formatMonthDay(dueKey)
}

/** 捕获条 chip 上的日期文案，周内一定带星期消歧 */
export function dateKeyLabel(key: string, now: Date = new Date()): string {
  const delta = diffDays(todayKey(now), key)
  if (delta === 0) return '今天'
  if (delta === 1) return '明天'
  if (delta === 2) return '后天'
  if (delta === -1) return '昨天'
  if (delta > 2 && delta <= 7) return `周${weekdayCn(key)} ${formatMonthDay(key)}`
  return formatMonthDay(key)
}

/** 本地日历日 + 可选时刻 → UTC ISO（供排序与跨端比较） */
export function toUtcIso(dateKey: string, time: string | null): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  if (time) {
    const [hh, mm] = time.split(':').map(Number)
    return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString()
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}
