/**
 * Reminder Scheduler（《00-架构设计》§4.3）。
 *
 * **刻意不用长 setTimeout**。Windows 睡眠/休眠后，长定时器会漂移甚至在唤醒后
 * 一次性把错过的全部补发出来 —— 用户合上笔记本三小时再打开，会连收三个弹窗。
 *
 * 改成「每 30 秒 tick 一次，每次只捞执行时刻已到的记录」：
 *   - 精度 30 秒，对「提前 N 天 + 定点 HH:mm」的提醒完全够用
 *   - 睡眠期间什么都不会发生，唤醒后只补发**仍然有意义**的那一条
 *   - 开销可忽略（一条走索引的 SELECT）
 */

import { powerMonitor } from 'electron'
import type { NotificationService } from '../../core/notification/notification.service'
import type { DispatchResult } from '@shared/types'

export type TickReason = 'interval' | 'startup' | 'wake' | 'manual'

/** tick 间隔。30 秒是「精度够用」与「开销可忽略」的平衡点 */
const TICK_INTERVAL_MS = 30_000

/**
 * 判定「时间跳变」的阈值。
 * 正常 tick 的间隔漂移在秒级；超过这个值只可能是系统休眠过或用户改了系统时间，
 * 此时必须全量重排，而不是信任旧计划。
 */
const DRIFT_THRESHOLD_MS = 4 * TICK_INTERVAL_MS

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null
  /** tick 内部要 await send()，重入会绕过「已发送」状态检查 */
  private ticking = false
  private lastTickMs = 0
  private lastResult: DispatchResult | null = null

  constructor(
    private readonly notifications: NotificationService,
    private readonly intervalMs: number = TICK_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return
    this.lastTickMs = Date.now()
    this.timer = setInterval(() => void this.tick('interval'), this.intervalMs)

    // 睡眠唤醒 / 解锁后定时器不可信，主动补一次
    powerMonitor.on('resume', this.handleWake)
    powerMonitor.on('unlock-screen', this.handleWake)

    // 启动立刻跑一次：把上次退出时错过的提醒补上
    void this.tick('startup')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    powerMonitor.removeListener('resume', this.handleWake)
    powerMonitor.removeListener('unlock-screen', this.handleWake)
  }

  isRunning(): boolean {
    return this.timer !== null
  }

  lastDispatch(): DispatchResult | null {
    return this.lastResult
  }

  private readonly handleWake = (): void => {
    void this.tick('wake')
  }

  async tick(reason: TickReason = 'interval', leadMs?: number): Promise<DispatchResult | null> {
    if (this.ticking) return null
    this.ticking = true
    try {
      const nowMs = Date.now()
      const drift = Math.abs(nowMs - this.lastTickMs)

      // 时间跳变 → 全量重排。注意顺序：先做崩溃恢复（把「计划过点但从未发送」
      // 的记录放回可排期状态），再重排，否则那些记录会一直是 skipped 发不出去。
      const jumped = reason === 'wake' || (this.lastTickMs > 0 && drift > DRIFT_THRESHOLD_MS)
      if (jumped) {
        const r = this.notifications.recoverAndReplanAll()
        console.log(
          `[scheduler] ${reason} 触发全量重排：恢复 ${r.recovered} 条中断计划，重排 ${r.plans}/${r.tasks} 个任务`
        )
      }
      this.lastTickMs = nowMs

      // 手动触发时放宽取数窗口：让「刚点完就检查」能立刻看到补发计划生效，
      // 否则用户得盯着屏幕等满 30 秒才能确认提醒引擎是活的
      const lead = leadMs ?? (reason === 'manual' ? 60_000 : 5_000)
      const result = await this.notifications.dispatchDue(lead)
      this.lastResult = result
      if (result.sent > 0 || result.failed > 0) {
        console.log(`[scheduler] ${reason}：待发 ${result.due}，成功 ${result.sent}，失败 ${result.failed}`)
      }
      return result
    } catch (err) {
      // 调度器是后台循环，抛出会让整个 tick 链断掉且无人接住
      console.error('[scheduler] tick 异常', err)
      return null
    } finally {
      this.ticking = false
    }
  }
}
