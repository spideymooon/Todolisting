/**
 * notification_logs 的读写层。
 *
 * 防重复通知的四道防线里，有两道落在本文件（《00-架构设计》§4.2）：
 *   防线 1：`plan_key` 上的 UNIQUE 约束 —— 数据库层物理拒绝重复计划
 *   防线 2：`upsertPlan()` 的幂等语义 —— 只有「从未真正发送过」的计划才允许重排
 */

import { randomUUID } from 'node:crypto'
import type { Db } from '../database/connection'
import type {
  NotificationLog,
  NotificationStatus,
  NotifyChannel,
  ReminderType
} from '@shared/types'

interface LogRow {
  id: string
  task_id: string
  task_title: string
  type: string
  scheduled_at: string
  plan_key: string
  channel: string
  status: string
  error: string | null
  sent_at: string | null
  created_at: string
}

function mapLog(row: LogRow): NotificationLog {
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    type: row.type as ReminderType,
    scheduledAt: row.scheduled_at,
    planKey: row.plan_key,
    channel: row.channel as NotifyChannel,
    status: row.status as NotificationStatus,
    error: row.error,
    sentAt: row.sent_at,
    createdAt: row.created_at
  }
}

export interface UpsertPlanInput {
  taskId: string
  taskTitle: string
  type: ReminderType
  planKey: string
  scheduledAt: string
  channel: NotifyChannel
  now: string
}

/**
 * upsertPlan 的结果。之所以要把它返回出来，是因为「这条提醒到底会不会发」
 * 是个必须可观测的问题 —— 设置页的提醒日志直接显示它。
 */
export type UpsertOutcome =
  /** 新计划 */
  | 'inserted'
  /** 同 key 的计划此前被作废（replan/崩溃），本次复活 —— 它从未发送过 */
  | 'revived'
  /** 同 key 的计划还在排队，更新了执行时刻 */
  | 'rescheduled'
  /** 已经真的发过了，不再重复（§23 的核心保证） */
  | 'already-sent'
  /** 发过但失败了，不自动重试，避免失败风暴 */
  | 'suppressed'

export class NotificationRepository {
  constructor(private readonly db: Db) {}

  /**
   * 幂等地写入一条提醒计划。
   *
   * 这里是整个防重复机制真正落地的地方。语义上把既有记录按「试过 / 没试过」分成两类：
   *   - sent / failed  = 试过了 → 永不重排（failed 由 Phase 3 的手动重发入口处理）
   *   - planned / cancelled / skipped = 没试过 → 可以重排
   *
   * 因为 plan_key 由「任务 + 意图时刻」决定，而不是「执行时刻」（执行时刻在 catch-up
   * 情形下每次算出来都不同），所以 replan 出来的 key 是稳定的 —— 这才是防线成立的前提。
   */
  upsertPlan(input: UpsertPlanInput): UpsertOutcome {
    const existing = this.db.get('SELECT id, status FROM notification_logs WHERE plan_key = ?', [
      input.planKey
    ]) as unknown as { id: string; status: NotificationStatus } | undefined

    if (!existing) {
      this.db.run(
        `INSERT INTO notification_logs
           (id, task_id, task_title, type, scheduled_at, plan_key, channel, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        [
          randomUUID(),
          input.taskId,
          input.taskTitle,
          input.type,
          input.scheduledAt,
          input.planKey,
          input.channel,
          input.now
        ]
      )
      return 'inserted'
    }

    switch (existing.status) {
      case 'sent':
        return 'already-sent'
      case 'failed':
        return 'suppressed'
      case 'planned':
        this.db.run(
          `UPDATE notification_logs
              SET scheduled_at = ?, channel = ?, task_title = ?
            WHERE id = ?`,
          [input.scheduledAt, input.channel, input.taskTitle, existing.id]
        )
        return 'rescheduled'
      case 'cancelled':
      case 'skipped':
      default:
        this.db.run(
          `UPDATE notification_logs
              SET status = 'planned', scheduled_at = ?, channel = ?,
                  task_title = ?, error = NULL
            WHERE id = ?`,
          [input.scheduledAt, input.channel, input.taskTitle, existing.id]
        )
        return 'revived'
    }
  }

  /** replan 的第一步：把该任务所有还在排队的计划作废（它们从未发送） */
  cancelPlannedForTask(taskId: string): number {
    const result = this.db.run(
      `UPDATE notification_logs SET status = 'cancelled'
        WHERE task_id = ? AND status = 'planned'`,
      [taskId]
    )
    return Number(result.changes ?? 0)
  }

  /**
   * 调度器每 30 秒打的唯一一条查询。
   * `scheduled_at` 是 ISO UTC 定长字符串，字典序即时间序，所以能直接比较。
   */
  findDue(nowIso: string, leadMs: number, limit = 50): NotificationLog[] {
    const ceiling = new Date(new Date(nowIso).getTime() + leadMs).toISOString()
    const rows = this.db.all(
      `SELECT * FROM notification_logs
        WHERE status = 'planned' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ${Math.floor(limit)}`,
      [ceiling]
    ) as unknown as LogRow[]
    return rows.map(mapLog)
  }

  findById(id: string): NotificationLog | null {
    const row = this.db.get('SELECT * FROM notification_logs WHERE id = ?', [id]) as
      | unknown as LogRow
      | undefined
    return row ? mapLog(row) : null
  }

  markSent(id: string, sentAt: string, note: string | null = null): void {
    this.db.run(
      `UPDATE notification_logs SET status = 'sent', sent_at = ?, error = ? WHERE id = ?`,
      [sentAt, note, id]
    )
  }

  markFailed(id: string, error: string): void {
    this.db.run(`UPDATE notification_logs SET status = 'failed', error = ? WHERE id = ?`, [error, id])
  }

  /**
   * 手动重发（§19「允许后续重新发送」）。
   *
   * 这是唯一能绕过「failed 不自动重试」的路径，而且必须是**用户显式点**的 ——
   * 自动重试会让一个持续失败的任务每 30 秒撞一次墙，手动重发则是明确的用户意图。
   */
  reviveForRetry(id: string, executeAtIso: string): void {
    this.db.run(
      `UPDATE notification_logs
          SET status = 'planned', scheduled_at = ?, error = NULL, sent_at = NULL
        WHERE id = ?`,
      [executeAtIso, id]
    )
  }

  markCancelled(id: string, reason: string): void {
    this.db.run(
      `UPDATE notification_logs SET status = 'cancelled', error = ? WHERE id = ?`,
      [reason, id]
    )
  }

  /**
   * 防线 4：崩溃恢复。
   *
   * 「planned 但执行时刻已经过去很久」只可能意味着进程在发送中途被杀。
   * 标记为 skipped 而不是 failed —— skipped 的语义是「从未真正试过发送」，
   * 所以 replanAll 会把它复活重排；标成 failed 就永远发不出去了。
   */
  recoverStale(cutoffIso: string): number {
    const result = this.db.run(
      `UPDATE notification_logs
          SET status = 'skipped', error = '进程中断，未发送，已重新排期'
        WHERE status = 'planned' AND scheduled_at < ?`,
      [cutoffIso]
    )
    return Number(result.changes ?? 0)
  }

  pendingCount(): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS n FROM notification_logs WHERE status = 'planned'`
    ) as unknown as { n?: number } | undefined
    return Number(row?.n ?? 0)
  }

  /** 下一条将要触发的提醒（设置页显示「下一次提醒：明天 09:00 交周报」） */
  nextPlanned(): NotificationLog | null {
    const row = this.db.get(
      `SELECT * FROM notification_logs WHERE status = 'planned'
        ORDER BY scheduled_at ASC LIMIT 1`
    ) as unknown as LogRow | undefined
    return row ? mapLog(row) : null
  }

  recent(limit = 50): NotificationLog[] {
    // rowid 兜底排序：同一次 replan 里插入的多条记录 created_at 完全相同，
    // 只按 created_at 排会得到不确定的顺序（「最近一条」会随机变）
    const rows = this.db.all(
      `SELECT * FROM notification_logs ORDER BY created_at DESC, rowid DESC LIMIT ${Math.floor(limit)}`
    ) as unknown as LogRow[]
    return rows.map(mapLog)
  }
}
