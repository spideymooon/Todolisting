/**
 * Notification Service —— 所有通知的**唯一出口**（《00-架构设计》§5.1）。
 *
 * 需求 §4 明确要求「不要把通知逻辑直接写死在 Todo 页面」，所以：
 *   task/ 与 renderer/ 都不直接碰通知，只通过 task.service 的 replan 钩子
 *   → 本服务 → Notifier 实现（桌面 / 微信）。
 *
 * 本文件仍然**不 import Electron**：Notifier 是注入进来的接口，
 * 桌面通知的具体实现放在 services/notification/ 下。
 */

import type { Db } from '../database/connection'
import { NotificationRepository, type UpsertOutcome } from './notification.repository'
import { buildMessage, type NotifyMessage } from './notification.message'
import { daysLeftFor, nextReminderAt, type ReminderDefaults, type ReminderPlan } from '@shared/reminder-plan'
import type { TaskRepository } from '../task/task.repository'
import type { DispatchResult, NotificationLog, NotifyResult, SchedulerStatus } from '@shared/types'

export type NotifyChannelKey = 'desktop' | 'wechat'

/** 通道实现。桌面通知与 PushPlus 各实现一个 */
export interface Notifier {
  readonly key: NotifyChannelKey
  send(msg: NotifyMessage): Promise<NotifyResult>
}

export interface PlanOutcome {
  plan: ReminderPlan
  /** 这次 replan 到底做了什么（inserted / revived / already-sent …） */
  outcome: UpsertOutcome
}

const CHANNEL_LABEL: Record<NotifyChannelKey, string> = {
  desktop: '桌面通知',
  wechat: '微信通知'
}

/** 崩溃恢复的判定窗口：plan 的执行时刻过去超过这么久，就认定进程是被杀掉的 */
const STALE_WINDOW_MS = 5 * 60_000

/**
 * 单次 tick 的发送上限。
 *
 * 防的是「关掉应用三天再打开，20 个任务的过期提醒同时糊到脸上」这种场景。
 * 超过上限的记录保持 planned 状态，下一个 tick 继续 —— 是延后，不是丢弃。
 * 更好的做法是把同一 tick 内的多条提醒汇总成一条（「3 个任务即将到期」），
 * 但那需要给日志加一个 grouped 状态，留到 Phase 7 打磨时做。
 */
const MAX_PER_TICK = 5

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class NotificationService {
  private readonly logs: NotificationRepository
  /** 防线 2 的补充：tick 是 async 的，send() 期间可能被下一次 tick 闯进来 */
  private readonly inFlight = new Set<string>()
  private lastTickAt: string | null = null

  constructor(
    db: Db,
    private readonly tasks: TaskRepository,
    private readonly defaults: () => ReminderDefaults,
    private readonly notifiers: Partial<Record<NotifyChannelKey, Notifier>> = {},
    private readonly now: () => Date = () => new Date()
  ) {
    this.logs = new NotificationRepository(db)
  }

  /**
   * 重新计算某个任务的提醒计划。task.service 里所有会改变提醒锚点的操作
   * （创建 / 完成 / 改日期 / 拖拽 / 删除）都在**同一事务内**调用它。
   */
  plan(taskId: string): PlanOutcome | null {
    const now = this.now()
    const nowIso = now.toISOString()

    // 1. 先把该任务排队中的计划全部作废
    this.logs.cancelPlannedForTask(taskId)

    // 2. 重新计算
    const task = this.tasks.findById(taskId)
    if (!task) return null
    const plan = nextReminderAt(task, this.defaults(), now, task.id)
    if (!plan) return null

    // 3. 幂等写入。同 key 且已发送过的计划会被 upsertPlan 拒绝，不会二次打扰
    const outcome = this.logs.upsertPlan({
      taskId: task.id,
      taskTitle: task.title,
      type: plan.type,
      planKey: plan.planKey,
      scheduledAt: plan.executeAtUtc,
      channel: plan.channel,
      now: nowIso
    })
    return { plan, outcome }
  }

  /** 启动时的崩溃恢复 + 全量重排（§4.2 防线 4） */
  recoverAndReplanAll(): { recovered: number; tasks: number; plans: number } {
    const cutoff = new Date(this.now().getTime() - STALE_WINDOW_MS).toISOString()
    const recovered = this.logs.recoverStale(cutoff)

    const ids = this.tasks.allPendingIds()
    let plans = 0
    for (const id of ids) {
      if (this.plan(id)) plans++
    }
    return { recovered, tasks: ids.length, plans }
  }

  /**
   * 调度器每 30 秒调用一次。
   * 只处理 `status='planned'` 且执行时刻已到的记录 —— 这是防重复的第一道闸门：
   * 发送成功后状态立刻变 sent，下一次 tick 就再也捞不到它。
   *
   * `leadMs` 正常是 5 秒（补上 tick 间隔的抖动）。设置页的「立即检查」会传更大的值，
   * 好让刚排上的补发计划当场就能看到效果，而不必等满 30 秒。
   */
  async dispatchDue(leadMs = 5_000): Promise<DispatchResult> {
    const now = this.now()
    this.lastTickAt = now.toISOString()

    const due = this.logs.findDue(now.toISOString(), leadMs)
    const result: DispatchResult = { due: due.length, sent: 0, failed: 0, cancelled: 0, reentrant: 0 }

    for (const log of due) {
      if (result.sent + result.failed >= MAX_PER_TICK) break
      if (this.inFlight.has(log.id)) {
        result.reentrant++
        continue
      }
      this.inFlight.add(log.id)
      try {
        const task = this.tasks.findById(log.taskId)
        // §5：任务已完成 / 已删除 → 不再发送，且不留待发计划
        if (!task) {
          this.logs.markCancelled(log.id, '任务已删除')
          result.cancelled++
          continue
        }
        if (task.status !== 'pending') {
          this.logs.markCancelled(log.id, '任务已完成')
          result.cancelled++
          continue
        }
        if (!task.dueDate) {
          this.logs.markCancelled(log.id, '任务已移除截止日期')
          result.cancelled++
          continue
        }

        const msg = buildMessage(task, {
          type: log.type,
          daysLeft: daysLeftFor(task.dueDate, now),
          planKey: log.planKey
        })

        const ok = await this.deliver(log, msg, now)
        if (ok) result.sent++
        else result.failed++
      } catch (err) {
        // 任何异常都只落到日志里，绝不上抛 —— §19 离线优先：
        // 微信通道挂掉不能影响任务创建/完成
        this.logs.markFailed(log.id, errText(err))
        result.failed++
      } finally {
        this.inFlight.delete(log.id)
      }
    }

    return result
  }

  private async deliver(log: NotificationLog, msg: NotifyMessage, now: Date): Promise<boolean> {
    const targets: NotifyChannelKey[] = []
    if (log.channel === 'desktop' || log.channel === 'both') targets.push('desktop')
    if (log.channel === 'wechat' || log.channel === 'both') targets.push('wechat')

    if (targets.length === 0) {
      this.logs.markCancelled(log.id, '没有可用的通知通道')
      return false
    }

    const errors: string[] = []
    let anyDelivered = false

    for (const key of targets) {
      const notifier = this.notifiers[key]
      if (!notifier) {
        errors.push(`${CHANNEL_LABEL[key]}：通道未就绪`)
        continue
      }
      try {
        const r = await notifier.send(msg)
        if (r.ok) anyDelivered = true
        else errors.push(`${CHANNEL_LABEL[key]}：${r.error ?? '发送失败'}`)
      } catch (err) {
        errors.push(`${CHANNEL_LABEL[key]}：${errText(err)}`)
      }
    }

    if (anyDelivered) {
      // 多通道时部分成功也算送达，但把失败通道记在 error 里，便于排查
      this.logs.markSent(log.id, now.toISOString(), errors.length > 0 ? errors.join('；') : null)
    } else {
      this.logs.markFailed(log.id, errors.join('；') || '未知错误')
    }
    return anyDelivered
  }

  status(running: boolean): SchedulerStatus {
    const next = this.logs.nextPlanned()
    return {
      running,
      lastTickAt: this.lastTickAt,
      pendingCount: this.logs.pendingCount(),
      nextDueAt: next?.scheduledAt ?? null,
      nextDueTitle: next?.taskTitle ?? null
    }
  }

  history(limit = 50): NotificationLog[] {
    return this.logs.recent(limit)
  }

  /**
   * 立即发一条测试通知，不经过排期。
   *
   * 这是设置页的「发送测试通知」按钮 —— §6 对 PushPlus 有同样的要求，
   * 桌面通道也一并做：让用户能在**不等到提醒时刻**的情况下确认整条链路是通的。
   * 否则第一次验证「通知到底能不能弹出来」要等到某天早上 09:00。
   */
  async sendTest(): Promise<Record<string, NotifyResult>> {
    const msg: NotifyMessage = {
      taskId: '',
      planKey: 'test',
      title: '📌 任务即将到期',
      body: '「提交周报」\n距离截止还有 2 天',
      detail: '这是一条来自 TodoList 的测试通知，说明提醒通道工作正常。'
    }
    const out: Record<string, NotifyResult> = {}
    for (const [key, notifier] of Object.entries(this.notifiers)) {
      if (!notifier) continue
      try {
        out[key] = await notifier.send(msg)
      } catch (err) {
        out[key] = { ok: false, error: errText(err) }
      }
    }
    if (Object.keys(out).length === 0) {
      out.none = { ok: false, error: '没有任何可用的通知通道' }
    }
    return out
  }

  /** 单看某条计划是否已经发送过 —— 测试与调试用 */
  logFor(planKey: string): NotificationLog | null {
    return this.logs.recent(200).find((l) => l.planKey === planKey) ?? null
  }

  /**
   * 手动重发一条失败/取消的通知（§19「允许后续重新发送」）。
   * 重置为 planned 并把执行时刻挪到 3 秒后，下一次 tick 就会捡起它。
   */
  retryLog(logId: string): boolean {
    const log = this.logs.findById(logId)
    if (!log) return false
    if (log.status !== 'failed' && log.status !== 'cancelled') return false
    this.logs.reviveForRetry(logId, new Date(this.now().getTime() + 3_000).toISOString())
    return true
  }
}
