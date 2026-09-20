/**
 * 提醒时刻计算（《00-架构设计》§4.1）
 *
 * 放在 `shared/` 而不是 `main/core/`，理由与 `capture-parse.ts` 完全一样：
 *   - 渲染层要在任务编辑器里**实时预览**「将于 9月18日 09:00 提醒」
 *   - 主进程要用同一份代码做权威计算
 *   - 两边必须是同一套逻辑，否则预览说的和实际做的会不一致
 *
 * 所以这个文件是**纯函数**：不 import Electron、不碰数据库、不读系统时间（now 一律注入）。
 * 它也因此能脱离整个桌面运行时直接单测。
 */

import { addDays, diffDays, fromDateKey, toDateKey } from './date'
import type { NotifyChannel, OverduePolicy, ReminderType, Task } from './types'

/** 只依赖 task 的这几个字段，方便测试里造最小对象 */
export type ReminderTask = Pick<
  Task,
  | 'title'
  | 'status'
  | 'dueDate'
  | 'dueTime'
  | 'reminderEnabled'
  | 'reminderDays'
  | 'reminderTime'
  | 'notifyChannels'
>

export interface ReminderDefaults {
  overduePolicy: OverduePolicy
  desktopNotifyEnabled: boolean
  wechatNotifyEnabled: boolean
}

export type ReminderReason = 'scheduled' | 'catch-up' | 'overdue'

export interface ReminderPlan {
  /** 实际执行时刻（UTC ISO）。catch-up / overdue 情形下是「现在 + 30s」 */
  executeAtUtc: string
  /** 计划**意图**时刻（本地 `YYYY-MM-DDTHH:mm`），与执行时刻解耦 —— 见下方说明 */
  intentAt: string
  /** 唯一键：`taskId|type|intentAt`。UNIQUE 约束就压在这个值上 */
  planKey: string
  type: ReminderType
  reason: ReminderReason
  channel: NotifyChannel
  /** 与截止日的本地日历日差，负数表示已逾期 */
  daysLeft: number
}

/** 补发的落地延迟。给用户留一点缓冲，避免「刚敲完回车就弹通知」的突兀感 */
export const CATCH_UP_DELAY_MS = 30_000

/** `HH:mm` → 当天的本地时刻。解析失败回落到兜底值，绝不抛错 */
function atLocal(dateKey: string, time: string, fallback: string): Date {
  const d = fromDateKey(dateKey)
  const [h, m] = parseHm(time) ?? parseHm(fallback) ?? [9, 0]
  d.setHours(h, m, 0, 0)
  return d
}

export function parseHm(time: string): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return [h, m]
}

export function isValidHm(time: string): boolean {
  return parseHm(time) !== null
}

export function padHm(time: string): string {
  const [h, m] = parseHm(time) ?? [9, 0]
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 该任务实际走哪些通道：任务自身的选择 ∩ 全局开关 */
export function effectiveChannel(task: ReminderTask, defaults: ReminderDefaults): NotifyChannel {
  const desktop =
    defaults.desktopNotifyEnabled &&
    (task.notifyChannels === 'desktop' || task.notifyChannels === 'both')
  const wechat =
    defaults.wechatNotifyEnabled &&
    (task.notifyChannels === 'wechat' || task.notifyChannels === 'both')
  if (desktop && wechat) return 'both'
  if (desktop) return 'desktop'
  if (wechat) return 'wechat'
  return 'none'
}

/**
 * 下一次提醒时刻。返回 null 表示「这个任务现在不该有任何提醒」。
 * 分支顺序即优先级，编号对应《00-架构设计》§4.1。
 */
export function nextReminderAt(
  task: ReminderTask,
  defaults: ReminderDefaults,
  now: Date,
  taskId = 'task'
): ReminderPlan | null {
  // ── ① 短路守卫 ──────────────────────────────────────
  // deleted_at 判断不在这里：软删除的行不会从 repository 里出来
  if (task.status === 'completed') return null // §5：已完成不再提醒
  if (!task.dueDate) return null // 无截止日 = 无提醒锚点
  if (!task.reminderEnabled) return null

  const channel = effectiveChannel(task, defaults)
  if (channel === 'none') return null // 两个通道都关

  const dueKey = task.dueDate
  const days = Math.max(0, Math.floor(task.reminderDays))
  const time = task.reminderTime

  // ── ② 基准：截止日往前推 N 天，再取 reminder_time ──────
  const remindKey = toDateKey(addDays(fromDateKey(dueKey), -days))
  const scheduled = atLocal(remindKey, time, '09:00')
  const deadline = atLocal(dueKey, task.dueTime ?? '23:59', '23:59')

  const todayKey = toDateKey(now)
  const daysLeft = diffDays(todayKey, dueKey)
  const nowMs = now.getTime()

  const intentAt = `${remindKey}T${padHm(time)}`

  /** 正常到点触发。传入的是**收敛后**的时刻，不是原始 scheduled */
  const atSchedule = (at: Date): ReminderPlan => ({
    executeAtUtc: at.toISOString(),
    intentAt,
    planKey: `${taskId}|reminder|${intentAt}`,
    type: 'reminder',
    reason: 'scheduled',
    channel,
    daysLeft
  })

  /**
   * 补发：提醒时刻已过，但还没到截止。
   *
   * executeAt 用「现在 + 30s」，但 plan_key 仍然用**原本的意图时刻** ——
   * 这样每次 replan 算出来的 key 都一样，`INSERT OR IGNORE` 才真的挡得住重复。
   * 如果 key 用 now+30s，每次重算都是一个新 key，防重复就彻底失效了。
   * 这是「执行时刻」与「意图时刻」必须分开的根本原因。
   */
  const catchUp = (reason: ReminderReason): ReminderPlan => ({
    executeAtUtc: new Date(nowMs + CATCH_UP_DELAY_MS).toISOString(),
    intentAt,
    planKey: `${taskId}|reminder|${intentAt}`,
    type: 'reminder',
    reason,
    channel,
    daysLeft
  })

  // ── ③ 收敛：提醒不得晚于截止 ────────────────────────
  // 例：截止 9-18 08:00、提前 0 天、提醒时间 09:00 → 09:00 晚于截止，
  // 提醒用户一件已经逾期的事毫无意义，所以按截止时刻收敛。
  // 注意 intentAt 仍然保留原始的 09:00 —— 它是计划的**身份**，不是执行时刻。
  const effective = scheduled.getTime() > deadline.getTime() ? deadline : scheduled

  // ── ④ 未来 → 正常排期 ───────────────────────────────
  if (effective.getTime() > nowMs) return atSchedule(effective)

  // ── ⑤ 已过提醒时刻 ──────────────────────────────────
  const overdue = deadline.getTime() < nowMs

  if (!overdue) {
    // 截止日在未来：属于「用户记晚了」。这正是需求评审里点出的最高频场景 ——
    // 9-19 才记「明天交周报」并设提前 2 天，提醒时刻 9-18 09:00 早已过去，
    // 若不补发，这个任务将**永远不提醒**。
    if (daysLeft > 0) return catchUp('catch-up')

    // 截止日就是今天、且写了具体时刻、时刻还没到 → 也值得补一次
    if (task.dueTime && deadline.getTime() > nowMs) return catchUp('catch-up')

    // 今天到期且没写时刻（捕获条最常见的产物）→ 不补发。
    // 此刻提醒「今天到期」没有信息增量，只会让连续记 5 条任务变成 5 个弹窗。
    return null
  }

  // ── ⑥ 已逾期 ────────────────────────────────────────
  if (defaults.overduePolicy === 'never') return null

  const overdueIntent = `overdue:${dueKey}`
  return {
    executeAtUtc: new Date(nowMs + CATCH_UP_DELAY_MS).toISOString(),
    intentAt: overdueIntent,
    planKey: `${taskId}|overdue|${overdueIntent}`,
    type: 'overdue',
    reason: 'overdue',
    channel,
    daysLeft
  }
}

/**
 * 本地日历日差。发送时刻才现算，而不是把天数写进日志 ——
 * 日志里存的是计划，天数是「计划执行时的事实」，用陈旧值会给出
 * 「距离截止还有 2 天」这种提醒了 3 天的错误文案。
 */
export function daysLeftFor(dueKey: string, now: Date): number {
  return diffDays(toDateKey(now), dueKey)
}

/** 距截止的文案（§5 通知正文 + §24 状态文案共用同一套措辞） */
export function describeRemaining(daysLeft: number): string {
  if (daysLeft > 0) return `距离截止还有 ${daysLeft} 天`
  if (daysLeft === 0) return '今天到期'
  return `已逾期 ${-daysLeft} 天`
}

/** 铃铛 tooltip / 列表里的提醒规则文案 */
export function describeReminderRule(task: ReminderTask): string {
  const days = Math.max(0, Math.floor(task.reminderDays))
  const time = padHm(task.reminderTime)
  return days === 0 ? `当天 ${time} 提醒` : `提前 ${days} 天 ${time} 提醒`
}

/** 给用户看的「将于 X 提醒」文案 */
export function describePlan(plan: ReminderPlan): string {
  const [dateKey, time] = plan.intentAt.split('T')
  const dateLabel = describePlanDate(dateKey)
  if (plan.reason === 'scheduled') return `${dateLabel} ${time}`
  if (plan.reason === 'catch-up') return `会立即提醒一次（原本的 ${dateLabel} ${time} 已过，但还没到期）`
  return '会立即提醒一次（任务已逾期）'
}

function describePlanDate(dateKey: string): string {
  if (dateKey.startsWith('overdue:')) return ''
  const d = fromDateKey(dateKey)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
