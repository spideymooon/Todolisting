import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../database/connection'
import { runMigrations } from '../database/migrate'
import { migrations } from '../database/migrations'
import { TaskRepository } from '../task/task.repository'
import { TaskService, type NewTaskReminderDefaults } from '../task/task.service'
import { NotificationService, type Notifier } from './notification.service'
import type { NotifyMessage } from './notification.message'
import type { NotifyResult } from '@shared/types'
import type { ReminderDefaults as PlannerDefaults } from '@shared/reminder-plan'

/** 记录所有「发出去」的通知，代替真实的 Windows toast */
class FakeNotifier implements Notifier {
  readonly key = 'desktop' as const
  readonly sent: NotifyMessage[] = []
  failNext = false

  async send(msg: NotifyMessage): Promise<NotifyResult> {
    if (this.failNext) return { ok: false, error: '模拟发送失败' }
    this.sent.push(msg)
    return { ok: true }
  }
}

/** 2026-09-17 周四 10:00 */
const NOW = new Date(2026, 8, 17, 10, 0, 0)

const NEW_TASK_DEFAULTS: NewTaskReminderDefaults = {
  reminderEnabled: true,
  reminderDays: 2,
  reminderTime: '09:00',
  notifyChannels: 'desktop'
}

let dir: string
let db: Db
let repo: TaskRepository
let notifier: FakeNotifier
let notifications: NotificationService
let service: TaskService
let clock: Date

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-todo-notify-'))
  db = openDatabase(join(dir, 'test.sqlite'), false).db
  runMigrations(db, migrations)

  repo = new TaskRepository(db)
  notifier = new FakeNotifier()
  clock = new Date(NOW)

  const defaults = (): PlannerDefaults => ({
    overduePolicy: 'once',
    desktopNotifyEnabled: true,
    wechatNotifyEnabled: false
  })

  notifications = new NotificationService(db, repo, defaults, { desktop: notifier }, () => clock)
  service = new TaskService(
    db,
    (id) => {
      notifications.plan(id)
    },
    () => NEW_TASK_DEFAULTS,
    repo
  )
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms)
}

describe('replan 幂等性', () => {
  it('创建任务就排好了计划，重复 replan 不会多出记录', () => {
    const task = service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    expect(notifications.status(false).pendingCount).toBe(1)

    const again = notifications.plan(task.id)
    expect(again?.outcome).toBe('revived')
    expect(notifications.status(false).pendingCount).toBe(1)
  })

  it('改了截止日期 → 旧计划作废，新计划排到新时刻，而不是叠加两条', () => {
    const task = service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    const before = notifications.history(5).find((l) => l.status === 'planned')?.scheduledAt
    expect(before).toBe(new Date(2026, 8, 18, 9, 0).toISOString())

    service.update(task.id, { dueDate: '2026-09-25' }, NOW)

    expect(notifications.status(false).pendingCount).toBe(1)
    const after = notifications.history(10).find((l) => l.status === 'planned')?.scheduledAt
    expect(after).toBe(new Date(2026, 8, 23, 9, 0).toISOString())
    // 旧计划是「作废」而不是「删除」—— 保留审计痕迹（§23）
    expect(notifications.history(10).some((l) => l.status === 'cancelled')).toBe(true)
  })
})

describe('防重复通知（§23）', () => {
  it('发送成功后再次 replan → already-sent，不会再发', async () => {
    const task = service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)

    // 走到提醒时刻（9-18 09:00）
    clock = new Date(2026, 8, 18, 9, 0, 0)
    const first = await notifications.dispatchDue()
    expect(first.sent).toBe(1)
    expect(notifier.sent).toHaveLength(1)

    const replan = notifications.plan(task.id)
    expect(replan?.outcome).toBe('already-sent')

    const second = await notifications.dispatchDue()
    expect(second.sent).toBe(0)
    expect(notifier.sent).toHaveLength(1)
  })

  it('连续两次 tick 不会重复发送', async () => {
    service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    clock = new Date(2026, 8, 18, 9, 0, 0)

    await notifications.dispatchDue()
    await notifications.dispatchDue()

    expect(notifier.sent).toHaveLength(1)
  })

  it('任务完成后计划被取消，不会再发（§5）', async () => {
    const task = service.create({ title: '提交周报', dueDate: '2026-09-18', reminderDays: 2 }, NOW)
    expect(notifications.status(false).pendingCount).toBe(1)

    service.toggle(task.id, NOW)
    expect(notifications.status(false).pendingCount).toBe(0)

    advance(60_000)
    const result = await notifications.dispatchDue(120_000)
    expect(result.sent).toBe(0)
    expect(notifier.sent).toHaveLength(0)
  })

  it('删除任务后同样不再发', async () => {
    const task = service.create({ title: '提交周报', dueDate: '2026-09-18', reminderDays: 2 }, NOW)
    service.remove(task.id, NOW)

    advance(60_000)
    const result = await notifications.dispatchDue(120_000)
    expect(result.sent).toBe(0)
  })

  it('发送失败不自动重试，但可以手动重发（§19）', async () => {
    service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    clock = new Date(2026, 8, 18, 9, 0, 0)

    notifier.failNext = true
    const failed = await notifications.dispatchDue()
    expect(failed.failed).toBe(1)

    // 自动重试被禁止：状态是 failed，scheduler 再也捞不到它
    notifier.failNext = false
    advance(5 * 60_000)
    const retryTick = await notifications.dispatchDue(600_000)
    expect(retryTick.due).toBe(0)
    expect(notifier.sent).toHaveLength(0)

    // 手动重发可以
    const logId = notifications.history(5)[0]?.id ?? ''
    expect(notifications.retryLog(logId)).toBe(true)
    advance(10_000)
    const afterRetry = await notifications.dispatchDue(60_000)
    expect(afterRetry.sent).toBe(1)
    expect(notifier.sent).toHaveLength(1)
  })

  it('崩溃恢复：中断的 planned 计划会被重新排期，而不是丢弃', () => {
    service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)

    // 模拟「进程在发送中途被杀」：计划过点很久仍是 planned
    db.run(`UPDATE notification_logs SET scheduled_at = ? WHERE status = 'planned'`, [
      '2026-09-01T00:00:00.000Z'
    ])

    const recovered = notifications.recoverAndReplanAll()
    expect(recovered.recovered).toBe(1)
    // 恢复后必须又有计划在排队，否则这条提醒就永远发不出去了
    expect(notifications.status(false).pendingCount).toBe(1)
  })
})

describe('补发窗口', () => {
  it('catch-up 计划 30 秒后才落地，不会在创建任务的那一瞬间弹出来', async () => {
    service.create({ title: '提交周报', dueDate: '2026-09-18', reminderDays: 2 }, NOW)

    const tooEarly = await notifications.dispatchDue(5_000)
    expect(tooEarly.due).toBe(0)

    advance(31_000)
    const onTime = await notifications.dispatchDue(5_000)
    expect(onTime.sent).toBe(1)
  })
})

describe('通知文案（§5）', () => {
  it('正常提醒用「任务即将到期」模板', async () => {
    service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    clock = new Date(2026, 8, 18, 9, 0, 0)
    await notifications.dispatchDue()

    expect(notifier.sent[0]?.title).toBe('📌 任务即将到期')
    expect(notifier.sent[0]?.body).toContain('「提交周报」')
    expect(notifier.sent[0]?.body).toContain('距离截止还有 2 天')
  })

  it('逾期提醒用「任务已逾期」模板', async () => {
    service.create({ title: '报销单', dueDate: '2026-09-15' }, NOW)
    advance(31_000)
    await notifications.dispatchDue(60_000)

    expect(notifier.sent[0]?.title).toBe('📌 任务已逾期')
    expect(notifier.sent[0]?.body).toContain('已逾期 2 天')
  })

  it('提醒时刻按发送当天现算，不用计划落库时的旧值', async () => {
    service.create({ title: '提交周报', dueDate: '2026-09-20' }, NOW)
    // 计划时是「还有 3 天」，实际发送被推迟到 9-19
    clock = new Date(2026, 8, 19, 9, 0, 0)
    await notifications.dispatchDue()

    expect(notifier.sent[0]?.body).toContain('距离截止还有 1 天')
  })
})

describe('单次 tick 的发送上限', () => {
  it('一次最多发 5 条，其余留到下一轮（防「关掉应用三天再打开」的通知风暴）', async () => {
    for (let i = 0; i < 8; i++) {
      service.create({ title: `任务 ${i}`, dueDate: '2026-09-20' }, NOW)
    }
    clock = new Date(2026, 8, 18, 9, 0, 0)

    const first = await notifications.dispatchDue()
    expect(first.sent).toBe(5)
    expect(notifications.status(false).pendingCount).toBe(3)

    const second = await notifications.dispatchDue()
    expect(second.sent).toBe(3)
    expect(notifications.status(false).pendingCount).toBe(0)
  })
})
