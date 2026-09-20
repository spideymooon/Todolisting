/**
 * 捕获条解析器（《01-UI设计规范》§3.4 / 《00-架构设计》§13.7）
 *
 * 设计约束 —— 三条，别破坏：
 *  1. **纯函数**。不碰 Date.now()（`now` 由调用方注入）、不碰 IO、不依赖 Electron/React。
 *  2. **闭集词表**，不引第三方 NLP 库。识别不了就回落默认落点，绝不报错、绝不阻塞提交。
 *  3. **同一份代码两处用**：渲染层拿它做 chip 实时预览，主进程拿它做入库前的权威解析。
 *     渲染层只把「原始文本 + 默认落点」交给主进程，**绝不传已解析出来的字段**。
 */

import { diffDays, offsetKey, toDateKey, weekdayIndex } from './date'

export type CaptureTarget = 'today' | 'pool'

export interface ParsedCapture {
  /** 剥离日期词与标签后的任务标题 */
  title: string
  /** 本地日历日 `YYYY-MM-DD`；null = 无日期（落待办池） */
  dueDate: string | null
  /** `HH:mm`；null = 不设具体时刻 */
  dueTime: string | null
  /** 解析出的标签名，不含 `#`。去重、保持出现顺序 */
  tags: string[]
  /** 命中的日期原文，用于 chip 展示；null = 未命中日期，走默认落点 */
  matchedDateText: string | null
  matchedTimeText: string | null
}

interface Range {
  start: number
  end: number
}

interface DateHit {
  dateKey: string
  time?: string
}

type Resolver<T> = (m: RegExpMatchArray, now: Date) => T | null

interface Rule<T> {
  re: RegExp
  resolve: Resolver<T>
}

// ────────────────────────────────────────────────────────────
// 词表
// ────────────────────────────────────────────────────────────

/** 「今晚」「明早」这类同时携带日期与时刻的词，必须最先匹配 */
const COMPOUND_RULES: Rule<DateHit>[] = [
  { re: /今晚|今天晚上/g, resolve: (_m, now) => ({ dateKey: toDateKey(now), time: '20:00' }) },
  { re: /明晚|明天晚上/g, resolve: (_m, now) => ({ dateKey: offsetKey(now, 1), time: '20:00' }) },
  { re: /明早|明天早上|明天上午/g, resolve: (_m, now) => ({ dateKey: offsetKey(now, 1), time: '08:00' }) }
]

/**
 * 顺序即优先级：长词在前，避免「大后天」被「后天」抢走。
 * 绝对日期（含年）必须排在 `M-D` 之前，否则 `2026-09-20` 会被切成 `26-09`。
 */
const DATE_RULES: Rule<string>[] = [
  { re: /大后天/g, resolve: (_m, now) => offsetKey(now, 3) },
  { re: /后天/g, resolve: (_m, now) => offsetKey(now, 2) },
  { re: /明天|明日/g, resolve: (_m, now) => offsetKey(now, 1) },
  { re: /今天|今日/g, resolve: (_m, now) => toDateKey(now) },
  { re: /(\d{1,3})\s*天\s*(?:后|以后)/g, resolve: (m, now) => offsetKey(now, Number(m[1])) },
  {
    re: /(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/g,
    resolve: (m, now) => resolveWeekday(m[1], m[2], now)
  },
  {
    re: /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/g,
    resolve: (m) => mkDateWithYear(Number(m[1]), Number(m[2]), Number(m[3]))
  },
  {
    re: /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/g,
    resolve: (m, now) => mkDateRolling(Number(m[1]), Number(m[2]), now)
  },
  {
    re: /(\d{1,2})\s*[-/]\s*(\d{1,2})(?!\d)/g,
    resolve: (m, now) => mkDateRolling(Number(m[1]), Number(m[2]), now)
  }
]

const TIME_RULES: Rule<string>[] = [
  {
    re: /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)\s*(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分?)?/g,
    resolve: (m) => mkTime(Number(m[2]), m[3] ? Number(m[3]) : 0, m[1])
  },
  {
    re: /(\d{1,2})\s*[:：]\s*(\d{2})/g,
    resolve: (m) => mkTime(Number(m[1]), Number(m[2]), undefined)
  },
  {
    re: /(\d{1,2})\s*[点时]\s*(?:(\d{1,2})\s*分?)?/g,
    resolve: (m) => mkTime(Number(m[1]), m[2] ? Number(m[2]) : 0, undefined)
  },
  {
    re: /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)/g,
    resolve: (m) => DEFAULT_HOUR[m[1]] ?? null
  }
]

const DEFAULT_HOUR: Record<string, string> = {
  凌晨: '01:00',
  早上: '08:00',
  早晨: '08:00',
  上午: '09:00',
  中午: '12:00',
  下午: '15:00',
  傍晚: '18:00',
  晚上: '20:00',
  夜里: '20:00'
}

const WEEKDAY: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 0
}

// ────────────────────────────────────────────────────────────
// 内部工具
// ────────────────────────────────────────────────────────────

function overlaps(claimed: Range[], start: number, end: number): boolean {
  return claimed.some((r) => start < r.end && end > r.start)
}

/** 找出该规则下**第一个未被占用且能成功解析**的匹配，避免首个无效匹配挡住后面的有效匹配 */
function firstResolved<T>(
  text: string,
  claimed: Range[],
  rule: Rule<T>,
  now: Date
): { match: RegExpMatchArray; value: T; range: Range } | null {
  for (const m of text.matchAll(rule.re)) {
    if (m.index === undefined) continue
    const start = m.index
    const end = start + m[0].length
    if (overlaps(claimed, start, end)) continue
    const value = rule.resolve(m, now)
    if (value === null || value === undefined) continue
    return { match: m, value, range: { start, end } }
  }
  return null
}

function stripRanges(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const r of sorted) {
    if (r.start > cursor) out += text.slice(cursor, r.start)
    cursor = Math.max(cursor, r.end)
  }
  out += text.slice(cursor)
  return out
}

/**
 * 不带年份的月/日：取**今天或之后最近的一次**，跨年自动进位。
 * 例：今天 2026-09-17，`9-20` → 2026-09-20；`1-05` → 2027-01-05。
 */
function mkDateRolling(month: number, day: number, now: Date): string | null {
  const thisYear = mkDateWithYear(now.getFullYear(), month, day)
  if (!thisYear) return null
  if (diffDays(toDateKey(now), thisYear) < 0) {
    return mkDateWithYear(now.getFullYear() + 1, month, day) ?? thisYear
  }
  return thisYear
}

function mkDateWithYear(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  if (year < 1970 || year > 9999) return null
  const probe = new Date(year, month - 1, day)
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null
  return toDateKey(probe)
}

/**
 * 周几。
 *
 * `下X` 必须落在**下一个自然周（周一起算）**里，不能简单地在「最近的周X」上加 7 天 ——
 * 否则今天周四说「下周五」会算成明天。这里先求出下周一，再按周一为基准偏移。
 *
 * 无前缀（或 `这X` / `本X`）取本周最近的一次，已过则顺延到下周。
 */
function resolveWeekday(prefix: string | undefined, ch: string, now: Date): string | null {
  const target = WEEKDAY[ch]
  if (target === undefined) return null
  const current = weekdayIndex(toDateKey(now))

  if (prefix === '下' || prefix === '下下') {
    const toNextMonday = (8 - current) % 7 || 7
    const dowFromMonday = target === 0 ? 7 : target
    const extraWeek = prefix === '下下' ? 7 : 0
    return offsetKey(now, toNextMonday + (dowFromMonday - 1) + extraWeek)
  }

  const delta = (target - current + 7) % 7
  return offsetKey(now, delta)
}

function mkTime(hourValue: number, minute: number, period: string | undefined): string | null {
  if (!Number.isFinite(hourValue) || !Number.isFinite(minute)) return null
  if (minute < 0 || minute > 59) return null
  let hour = hourValue
  if (period === '凌晨') {
    if (hour >= 12) hour -= 12
  } else if (period === '上午' || period === '早上' || period === '早晨') {
    // 原样
  } else if (period === '中午') {
    if (hour < 11) hour += 12
  } else if (period) {
    if (hour < 12) hour += 12
  }
  if (hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// ────────────────────────────────────────────────────────────
// 对外入口
// ────────────────────────────────────────────────────────────

export const EMPTY_CAPTURE: ParsedCapture = {
  title: '',
  dueDate: null,
  dueTime: null,
  tags: [],
  matchedDateText: null,
  matchedTimeText: null
}

export interface ParseOptions {
  /** 注入「现在」，让解析可测试、可复现 */
  now?: Date
  /** 未解析出日期时的落点 */
  defaultTarget?: CaptureTarget
}

export function parseCapture(raw: string, opts: ParseOptions = {}): ParsedCapture {
  const now = opts.now ?? new Date()
  const defaultTarget = opts.defaultTarget ?? 'today'
  const text = raw.trim()

  if (!text) return { ...EMPTY_CAPTURE }

  const claimed: Range[] = []
  const claim = (r: Range): void => {
    claimed.push(r)
  }

  // 1) 标签 —— 最先抽取，避免 `#工作` 里的字符干扰日期词
  const tags: string[] = []
  for (const m of text.matchAll(/#([^\s#]{1,16})/g)) {
    if (m.index === undefined) continue
    if (!tags.includes(m[1])) tags.push(m[1])
    claim({ start: m.index, end: m.index + m[0].length })
  }

  let dueDate: string | null = null
  let dueTime: string | null = null
  let matchedDateText: string | null = null
  let matchedTimeText: string | null = null

  // 2) 复合词（今晚 / 明早）
  for (const rule of COMPOUND_RULES) {
    const hit = firstResolved(text, claimed, rule, now)
    if (!hit) continue
    dueDate = hit.value.dateKey
    if (hit.value.time) dueTime = hit.value.time
    matchedDateText = hit.match[0]
    matchedTimeText = hit.match[0]
    claim(hit.range)
    break
  }

  // 3) 纯日期
  if (!dueDate) {
    for (const rule of DATE_RULES) {
      const hit = firstResolved(text, claimed, rule, now)
      if (!hit) continue
      dueDate = hit.value
      matchedDateText = hit.match[0]
      claim(hit.range)
      break
    }
  }

  // 4) 时刻（先精确到点，再退化到「下午」这类只给时段的词）
  if (!dueTime) {
    for (const rule of TIME_RULES) {
      const hit = firstResolved(text, claimed, rule, now)
      if (!hit) continue
      dueTime = hit.value
      matchedTimeText = hit.match[0]
      claim(hit.range)
      break
    }
  }

  // 5) 标题 = 原文 - 已占用片段
  let title = stripRanges(text, claimed)
  title = title
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，。、;；:：\-–—]+/, '')
    .replace(/[\s,，。、;；:：\-–—]+$/, '')
    .trim()

  // 整句都被吃光（例如只输入了「明天」）时，退化为原文去标签，避免出现空标题任务
  if (!title) {
    title = text.replace(/#[^\s#]{1,16}/g, '').trim() || text
  }

  // 6) 未解析出日期 → 用默认落点
  if (!dueDate && defaultTarget === 'today') {
    dueDate = toDateKey(now)
  }

  return { title, dueDate, dueTime, tags, matchedDateText, matchedTimeText }
}

/** chip 落点文案：命中日期就显示日期，否则显示默认落点 */
export function captureTargetLabel(
  parsed: ParsedCapture,
  target: CaptureTarget,
  formatDate: (key: string) => string
): string {
  if (parsed.matchedDateText && parsed.dueDate) return formatDate(parsed.dueDate)
  return target === 'today' ? '今天' : '待办池'
}
