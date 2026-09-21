/**
 * 重复任务规则的**纯函数层** —— 只做日期推进，不碰数据库、不碰 Electron。
 *
 * 设计原则（《TodoList-重复任务功能》§6 / §12 / §15）：
 *  1. **规则 + 当前实例，绝不预生成未来任务** —— 本文件只回答「下一次是哪天」，
 *     不批量产出日期列表。调用方负责按需生成一个实例。
 *  2. 全部基于 `YYYY-MM-DD` 本地日历日字符串运算，复用 @shared/date 的工具，
 *     时刻（HH:mm）原样继承，不参与推进 —— 避免时区换算把日期错位一天。
 *  3. 零外部依赖，离线可用。
 *  4. **不通过标题文字判断重复** —— 重复性只来自 RepeatRule 本身。
 */

import { addDays, fromDateKey, toDateKey, weekdayCn, weekdayIndex } from './date'

export type RepeatFreq = 'daily' | 'weekday' | 'weekly' | 'monthly' | 'yearly' | 'custom'
export type RepeatUnit = 'day' | 'week' | 'month'
export type RepeatEndType = 'never' | 'until' | 'count'

export interface RepeatRule {
  freq: RepeatFreq
  /** custom 专用：每 N 个单位（>=1） */
  interval: number
  /** custom 专用单位 */
  unit: RepeatUnit
  /** weekly 专用：0=周日 … 6=周六，至少一个 */
  weekdays: number[]
  endType: RepeatEndType
  /** endType='until'：最后一次发生的日期上限（含当天） */
  endDate: string | null
  /** endType='count'：总共发生次数（含首次） */
  endCount: number
  /** 已发生次数（含当前实例）。用于 endType='count' 收敛 */
  doneCount: number
}

/** 界面上的「重复」下拉项。label 是给用户看的，value 是存库的 freq */
export const REPEAT_FREQ_OPTIONS: ReadonlyArray<{ value: RepeatFreq; label: string }> = [
  { value: 'daily', label: '每天' },
  { value: 'weekday', label: '每个工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
  { value: 'custom', label: '自定义' }
]

export const REPEAT_UNIT_OPTIONS: ReadonlyArray<{ value: RepeatUnit; label: string }> = [
  { value: 'day', label: '天' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' }
]

export const REPEAT_END_OPTIONS: ReadonlyArray<{ value: RepeatEndType; label: string }> = [
  { value: 'never', label: '永不' },
  { value: 'until', label: '指定日期' },
  { value: 'count', label: '重复次数' }
]

export const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'] as const

const FREQS: RepeatFreq[] = ['daily', 'weekday', 'weekly', 'monthly', 'yearly', 'custom']
const UNITS: RepeatUnit[] = ['day', 'week', 'month']
const END_TYPES: RepeatEndType[] = ['never', 'until', 'count']

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 默认规则：每天，永不结束。新建重复任务时的起点 */
export function defaultRule(freq: RepeatFreq = 'daily', fromDateKey: string | null = null): RepeatRule {
  return {
    freq,
    interval: 1,
    unit: 'day',
    weekdays: fromDateKey ? [weekdayIndex(fromDateKey)] : [],
    endType: 'never',
    endDate: null,
    endCount: 10,
    doneCount: 1
  }
}

function toPositiveInt(raw: unknown, fallback: number, max = 365): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < 1) return fallback
  return Math.min(i, max)
}

/** endCount 语义上必须 >= 2（=1 意味着「只发生这一次」，那就不该建重复规则） */
function clampEndCount(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 2) return 2
  return Math.min(n, 999)
}

/**
 * 把「来自 UI / IPC / 数据库 JSON」的任意输入收敛成合法规则。
 * 任何非法输入返回 null（= 不重复），**绝不抛错** —— 一条坏数据不该让列表炸掉。
 */
export function normalizeRule(raw: unknown): RepeatRule | null {
  if (raw === null || raw === undefined) return null
  let obj: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      obj = JSON.parse(text)
    } catch {
      return null
    }
  }
  if (typeof obj !== 'object' || obj === null) return null

  const r = obj as Partial<RepeatRule>
  if (!r.freq || !FREQS.includes(r.freq)) return null

  const weekdays = Array.isArray(r.weekdays)
    ? Array.from(new Set(r.weekdays.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))).sort(
        (a, b) => a - b
      )
    : []

  const endType: RepeatEndType = r.endType && END_TYPES.includes(r.endType) ? r.endType : 'never'

  const rule: RepeatRule = {
    freq: r.freq,
    interval: toPositiveInt(r.interval, 1),
    unit: r.unit && UNITS.includes(r.unit) ? r.unit : 'day',
    weekdays: r.freq === 'weekly' && weekdays.length === 0 ? [1] : weekdays,
    endType,
    endDate:
      typeof r.endDate === 'string' && DATE_KEY_RE.test(r.endDate.trim()) ? r.endDate.trim() : null,
    endCount: clampEndCount(r.endCount),
    doneCount: toPositiveInt(r.doneCount, 1, 99999)
  }

  // until 但没给合法日期 → 退化成「永不」。宁可多提醒也不要静默停掉一条规则
  if (rule.endType === 'until' && !rule.endDate) rule.endType = 'never'
  return rule
}

/** 序列化成数据库里的 TEXT（JSON）。null 规则返回 null */
export function serializeRule(rule: RepeatRule | null | undefined): string | null {
  const normalized = normalizeRule(rule)
  return normalized ? JSON.stringify(normalized) : null
}

/** 从数据库列值解析。坏数据一律当「不重复」 */
export function parseRule(raw: string | null | undefined): RepeatRule | null {
  return normalizeRule(raw)
}

/** 某年某月的天数。month 为 1-12 */
export function daysInMonth(year: number, month: number): number {
  // 下月 0 号 = 本月最后一天
  return new Date(year, month, 0).getDate()
}

/** 把「日」收敛到当月合法范围：1月31日 → 2月28/29日（§4） */
function clampDayToMonth(year: number, month: number, day: number): string {
  const last = daysInMonth(year, month)
  return toDateKey(new Date(year, month - 1, Math.min(day, last)))
}

/** 月份推进（保持日，超界收敛到月末） */
function addMonthsClamped(fromKey: string, months: number): string {
  const d = fromDateKey(fromKey)
  const total = d.getMonth() + months
  const year = d.getFullYear() + Math.floor(total / 12)
  const month = (total % 12 + 12) % 12 + 1
  return clampDayToMonth(year, month, d.getDate())
}

/** 年份推进（2月29日在平年收敛到2月28日） */
function addYearsClamped(fromKey: string, years: number): string {
  const d = fromDateKey(fromKey)
  return clampDayToMonth(d.getFullYear() + years, d.getMonth() + 1, d.getDate())
}

function nextWeekdayKey(fromKey: string): string {
  let cursor = addDays(fromDateKey(fromKey), 1)
  // 最多转 7 次必然命中一个工作日，这里给 10 次余量足够
  for (let i = 0; i < 10; i++) {
    const idx = cursor.getDay()
    if (idx !== 0 && idx !== 6) return toDateKey(cursor)
    cursor = addDays(cursor, 1)
  }
  return toDateKey(cursor)
}

/** weekly：从 weekdays 里找**严格大于** from 的最近星期；没有就跳到下周的同一个 */
function nextWeeklyKey(rule: RepeatRule, fromKey: string): string {
  const days = rule.weekdays.length > 0 ? rule.weekdays : [weekdayIndex(fromKey)]
  const current = weekdayIndex(fromKey)
  const sorted = [...days].sort((a, b) => a - b)

  for (const d of sorted) {
    const delta = d - current
    if (delta > 0) return toDateKey(addDays(fromDateKey(fromKey), delta))
  }
  // 本周内没有更晚的星期 → 绕到下周第一个（interval 表示「每 N 周」）
  const first = sorted[0]
  const delta = 7 - current + first + (rule.interval - 1) * 7
  return toDateKey(addDays(fromDateKey(fromKey), delta))
}

/**
 * 主入口：给定规则与基准日，返回**下一次**发生日。
 *
 * - 基准日通常是「当前活跃实例的 dueDate」。
 * - 返回 null 表示不该再生成下一次（规则已完成 / 无基准日）。
 * - 返回值严格大于 fromDateKey（weekly 多星期同周内前进时也是）。
 */
export function nextOccurrence(
  rule: RepeatRule | null,
  fromKey: string | null
): string | null {
  const r = normalizeRule(rule)
  if (!r || !fromKey || !DATE_KEY_RE.test(fromKey)) return null

  let next: string
  switch (r.freq) {
    case 'daily':
      next = toDateKey(addDays(fromDateKey(fromKey), r.interval))
      break
    case 'weekday':
      // §4「工作日跳过周六日」：周五完成后落到下周一
      next = nextWeekdayKey(fromKey)
      break
    case 'weekly':
      next = nextWeeklyKey(r, fromKey)
      break
    case 'monthly':
      next = addMonthsClamped(fromKey, r.interval)
      break
    case 'yearly':
      next = addYearsClamped(fromKey, r.interval)
      break
    case 'custom':
    default:
      if (r.unit === 'day') next = toDateKey(addDays(fromDateKey(fromKey), r.interval))
      else if (r.unit === 'week') next = toDateKey(addDays(fromDateKey(fromKey), r.interval * 7))
      else next = addMonthsClamped(fromKey, r.interval)
      break
  }

  // 兜底：推进结果必须严格在基准日之后，否则说明规则有病，直接停
  if (!(next > fromKey)) return null
  if (isRuleFinished(r, next)) return null
  return next
}

/**
 * 是否已达结束条件。
 * `nextKey` 是**将要生成的**那一次，所以 count 用 doneCount（已发生）比较。
 */
export function isRuleFinished(rule: RepeatRule, nextKey?: string): boolean {
  if (rule.endType === 'until') {
    if (!rule.endDate || !nextKey) return false
    return nextKey > rule.endDate
  }
  if (rule.endType === 'count') {
    return rule.doneCount >= rule.endCount
  }
  return false
}

/** 完成一次后推进计数。endType='count' 靠它收敛 */
export function bumpDoneCount(rule: RepeatRule): RepeatRule {
  return { ...rule, doneCount: rule.doneCount + 1 }
}

/** 规则的人类可读描述。用于列表标记的 title 与编辑器回显 */
export function describeRule(rule: RepeatRule | null): string {
  const r = normalizeRule(rule)
  if (!r) return ''

  switch (r.freq) {
    case 'daily':
      return r.interval > 1 ? `每 ${r.interval} 天` : '每天'
    case 'weekday':
      return '每个工作日'
    case 'weekly': {
      // 「每周一」不是「每周周一」—— 前缀已含「周」时不再重复
      const names = r.weekdays.map((d) => (d === 1 ? '一' : `周${WEEKDAY_LABELS[d]}`))
      return r.interval > 1
        ? `每 ${r.interval} 周周${r.weekdays.map((d) => WEEKDAY_LABELS[d]).join('、')}`
        : `每周${names.join('、')}`
    }
    case 'monthly':
      return r.interval > 1 ? `每 ${r.interval} 个月` : '每月'
    case 'yearly':
      return r.interval > 1 ? `每 ${r.interval} 年` : '每年'
    case 'custom':
    default: {
      const unitLabel = r.unit === 'day' ? '天' : r.unit === 'week' ? '周' : '个月'
      return r.interval > 1 ? `每 ${r.interval} ${unitLabel}` : `每${unitLabel}`
    }
  }
}

/** 结束条件的人类可读描述。'never' 返回空串（不显示） */
export function describeRuleEnd(rule: RepeatRule | null): string {
  const r = normalizeRule(rule)
  if (!r) return ''
  if (r.endType === 'until' && r.endDate) return `至 ${r.endDate}`
  if (r.endType === 'count') return `共 ${r.endCount} 次`
  return ''
}

/** 编辑器里显示的「下次：X」提示（可选，给用户确认规则是否如预期） */
export function describeNextOccurrence(
  rule: RepeatRule | null,
  fromKey: string | null
): string | null {
  const next = nextOccurrence(rule, fromKey)
  if (!next) return null
  const d = fromDateKey(next)
  return `${d.getMonth() + 1}月${d.getDate()}日 周${weekdayCn(next)}`
}

/** 每周多选 chips 需要的标签 */
export function weekdayShortLabel(index: number): string {
  return WEEKDAY_LABELS[index] ?? ''
}
