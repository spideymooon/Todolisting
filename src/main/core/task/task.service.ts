/**
 * 任务业务层。
 *
 * 两条硬性约束（《00-架构设计》）：
 *  1. 不 import 任何 Electron API —— 所以这个文件能脱离 Electron 直接单测。
 *  2. 任何会改变「提醒锚点」的操作（due_date / status）都必须走**同一个事务**，
 *     并且在同一事务里调用 `replan()`。否则会出现「列已经变了但提醒没重算」的中间态。
 */

import { randomUUID } from 'node:crypto'
import { inTransaction, type Db } from '../database/connection'
import { TaskRepository, tagColorFor } from './task.repository'
import { parseCapture, type CaptureTarget } from '@shared/capture-parse'
import { offsetKey, toDateKey, toUtcIso, weekdayIndex } from '@shared/date'
import {
  bumpDoneCount,
  nextOccurrence,
  normalizeRule,
  serializeRule,
  type RepeatRule
} from '@shared/repeat'
import type {
  BoardData,
  CaptureResult,
  CreateTaskInput,
  MoveTarget,
  NotifyChannel,
  Tag,
  Task,
  TaskPatch
} from '@shared/types'

/** 提醒重算钩子。由 NotificationService 注入，见 src/main/index.ts 的装配顺序 */
export type ReplanHook = (taskId: string) => void

/** 新建任务时提醒字段的初始值（来自全局默认设置） */
export interface NewTaskReminderDefaults {
  reminderEnabled: boolean
  reminderDays: number
  reminderTime: string
  notifyChannels: NotifyChannel
}

export type ReminderDefaultsProvider = () => NewTaskReminderDefaults

export type ListScope = 'today' | 'upcoming' | 'window' | 'all' | 'completed'

/**
 * 小组件时间窗长度（天）。今天 + 2 = 覆盖到后天，与 §14.4 的四组分组一致。
 * 想改「小组件看多远」只改这一个数字。
 */
const WIDGET_WINDOW_DAYS = 2

const FALLBACK_REMINDER_DEFAULTS: NewTaskReminderDefaults = {
  reminderEnabled: true,
  reminderDays: 1,
  reminderTime: '09:00',
  notifyChannels: 'desktop'
}

export class TaskService {
  private readonly repo: TaskRepository

  constructor(
    private readonly db: Db,
    private readonly replan: ReplanHook = () => undefined,
    private readonly reminderDefaults: ReminderDefaultsProvider = () => FALLBACK_REMINDER_DEFAULTS,
    repo?: TaskRepository
  ) {
    // repo 允许注入：notification.service 也要读任务，两者共用同一个实例更省事，
    // 也避免同一个 db 上出现两套查询逻辑
    this.repo = repo ?? new TaskRepository(db)
  }

  board(now: Date = new Date()): BoardData {
    const todayKey = toDateKey(now)
    return {
      pool: this.repo.findTasksByColumn('pool', todayKey),
      todayPending: this.repo.findTasksByColumn('todayPending', todayKey),
      todayDone: this.repo.findTasksByColumn('todayDone', todayKey),
      todayKey
    }
  }

  list(scope: ListScope, now: Date = new Date()): Task[] {
    const todayKey = toDateKey(now)
    // 小组件的窗口末端 = 今天 + 2 天（后天）。放这里算而不是让渲染层算，
    // 是为了避免「跨零点时前端算出的边界与主进程不一致」
    const windowEndKey = offsetKey(now, WIDGET_WINDOW_DAYS)
    return this.repo.findTasks(scope, todayKey, 500, windowEndKey)
  }

  /** 全局搜索：直接透传仓库层（纯查询，无业务规则） */
  search(query: string): Task[] {
    return this.repo.search(query)
  }

  counts(now: Date = new Date()): ReturnType<TaskRepository['counts']> {
    return this.repo.counts(toDateKey(now))
  }

  listTags(): Tag[] {
    return this.repo.allTags()
  }

  /**
   * 捕获条唯一入口。
   * 注意：只接受**原始文本 + 默认落点**，解析在这里做 —— 渲染层传过来的任何
   * 「已解析字段」都不予采信（《00-架构设计》§9）。
   */
  capture(raw: string, target: CaptureTarget, now: Date = new Date()): CaptureResult {
    const parsed = parseCapture(raw, { now, defaultTarget: target })
    if (!parsed.title.trim()) {
      return { ok: false, error: '内容为空' }
    }
    try {
      const task = this.create(
        {
          title: parsed.title,
          dueDate: parsed.dueDate,
          dueTime: parsed.dueTime,
          tags: parsed.tags
        },
        now
      )
      return { ok: true, task }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  create(input: CreateTaskInput, now: Date = new Date()): Task {
    const id = randomUUID()
    const nowIso = now.toISOString()
    const dueDate = input.dueDate ?? null
    const dueTime = input.dueTime ?? null

    // 全局默认在这里**快照**进任务，而不是留 null 表示「跟随全局」。
    // 理由见 @shared/types 里 DEFAULT_SETTINGS 下方的注释：继承会让「改一次默认」
    // 静默重排全库历史任务的提醒，用户无法预期。
    const defaults = this.reminderDefaults()

    const repeatRule = this.prepareRule(input.repeatRule, dueDate)

    return inTransaction(this.db, () => {
      this.repo.insert({
        id,
        title: input.title,
        note: input.note ?? null,
        priority: input.priority ?? 3,
        dueDate,
        dueTime,
        dueAtUtc: dueDate ? toUtcIso(dueDate, dueTime) : null,
        reminderEnabled: input.reminderEnabled ?? defaults.reminderEnabled,
        reminderDays: Math.max(0, Math.floor(input.reminderDays ?? defaults.reminderDays)),
        reminderTime: input.reminderTime ?? defaults.reminderTime,
        notifyChannels: input.notifyChannels ?? defaults.notifyChannels,
        repeatRule,
        // 首个实例：series_id 写自身 id，后续实例继承同一个值。
        // 这样「这条规则的所有实例」= WHERE series_id = ? 一条查询搞定
        seriesId: repeatRule ? id : null,
        now: nowIso
      })
      if (input.tags && input.tags.length > 0) {
        this.applyTags(id, input.tags, nowIso)
      }
      const created = this.repo.findById(id)
      if (!created) throw new Error('创建任务失败：写入后读不回')
      this.replan(id)
      return created
    })
  }

  /** 勾选完成 / 取消完成 */
  toggle(id: string, now: Date = new Date()): Task | null {
    const nowIso = now.toISOString()
    return inTransaction(this.db, () => {
      const existing = this.repo.findById(id)
      if (!existing) return null
      const nextStatus = existing.status === 'pending' ? 'completed' : 'pending'
      this.repo.update(
        id,
        {
          status: nextStatus,
          completed_at: nextStatus === 'completed' ? nowIso : null
        },
        nowIso
      )

      // §7：**完成时**才生成下一次（绝不预生成未来任务）。
      // 与状态变更、replan 同处一个事务 —— 要么都成要么都不成。
      const spawned =
        nextStatus === 'completed' ? this.spawnNextOccurrence(existing, nowIso) : null

      this.replan(id)
      // 新实例的提醒也要排上（§9：每周都要提醒）
      if (spawned) this.replan(spawned.id)

      return this.repo.findById(id)
    })
  }

  /**
   * 生成下一实例。返回新任务 id；不该生成 / 已存在时返回 null。
   *
   * 幂等三重保障（§14）：
   *  1. 只从 `pending → completed` 方向进入（调用方保证），取消勾选不会再来一遍
   *  2. `findBySeriesAndDueDate` 唯一性判断 —— 重启 / 唤醒 / 调度器 / 快速连点都会在这里被挡下
   *  3. 全部写入在同一个 BEGIN IMMEDIATE 事务里，node-sqlite3-wasm 是同步 API，
   *     不存在「两个生成逻辑交错」的窗口
   *
   * ⚠ 刻意不做的事：不改动被完成的那条老实例。它的 due_date / completed_at 原样保留，
   * 所以「今日已完成」与「已完成」页里每次历史都完整（§8 / §13）。
   */
  private spawnNextOccurrence(existing: Task, nowIso: string): Task | null {
    const rule = normalizeRule(existing.repeatRule)
    if (!rule) return null

    // 无截止日就没有「下一次」的基准。§4 的推进全部以 dueDate 为锚点
    const nextDate = nextOccurrence(rule, existing.dueDate)
    if (!nextDate) return null

    const seriesId = existing.seriesId ?? existing.id
    // 幂等防线：这一步挡住「重启后重跑生成逻辑」「快速连点两次完成」
    if (this.repo.findBySeriesAndDueDate(seriesId, nextDate)) return null

    const nextId = randomUUID()
    this.repo.insert({
      id: nextId,
      title: existing.title,
      note: existing.note,
      priority: existing.priority,
      dueDate: nextDate,
      dueTime: existing.dueTime,
      dueAtUtc: toUtcIso(nextDate, existing.dueTime),
      reminderEnabled: existing.reminderEnabled,
      reminderDays: existing.reminderDays,
      reminderTime: existing.reminderTime,
      notifyChannels: existing.notifyChannels,
      // 规则带着「已发生次数 + 1」续下去，endType='count' 靠它收敛
      repeatRule: bumpDoneCount(rule),
      seriesId,
      now: nowIso
    })

    // 标签继承：重复任务多半也需要同样的分类
    if (existing.tags.length > 0) {
      for (const tag of existing.tags) this.repo.linkTag(nextId, tag.id)
    }

    // 注意：这里**不**判断 nextDate 是不是今天。是不是「今日待完成」由
    // board() 的 due_date <= todayKey 自然决定（§7：下一次不是今天就不提前进今日）
    return this.repo.findById(nextId)
  }

  /**
   * 把 UI / IPC 传来的规则收敛成合法值，并处理「基准日」关系。
   *
   * 两条规则：
   *  - weekly 没给星期 → 用 dueDate 的星期（§4「每周按当前截止日的星期几」）
   *  - 没有 dueDate 就不该有重复规则（没有推进锚点），降级为不重复
   */
  private prepareRule(raw: RepeatRule | null | undefined, dueDate: string | null): RepeatRule | null {
    if (raw === null || raw === undefined) return null
    const rule = normalizeRule(raw)
    if (!rule) return null
    if (!dueDate) return null

    if (rule.freq === 'weekly') {
      // §4「每周按当前截止日的星期几」。
      // ⚠ 必须在 normalizeRule **之前**看原始 weekdays —— normalizeRule 会把
      // 空数组兜底成 [1]（周一），先归一化就再也分不出「用户没选」和「用户选了周一」。
      const rawWeekdays = (raw as Partial<RepeatRule>).weekdays
      const given = Array.isArray(rawWeekdays)
        ? rawWeekdays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        : []
      if (given.length === 0) return { ...rule, weekdays: [weekdayIndex(dueDate)] }
    }
    return rule
  }

  /**
   * 看板拖拽的**原子操作**（《00-架构设计》§13.2）。
   *
   * 拖拽改的不是「列」，是 due_date / status 两个字段：
   *   pool         → due_date = null                    （取消提醒锚点）
   *   todayPending → status='pending', due_date = 今天   （重新计算提醒）
   *   todayDone    → status='completed', completed_at    （取消未发提醒）
   *
   * 字段变更与 replan 在同一事务里，UI 只调这一个方法，不自己拼字段。
   */
  moveTask(id: string, target: MoveTarget, now: Date = new Date()): Task | null {
    const todayKey = toDateKey(now)
    const nowIso = now.toISOString()

    return inTransaction(this.db, () => {
      const existing = this.repo.findById(id)
      if (!existing) return null

      switch (target) {
        case 'pool':
          this.repo.update(
            id,
            { due_date: null, due_time: null, due_at_utc: null },
            nowIso
          )
          break
        case 'todayPending':
          this.repo.update(
            id,
            {
              status: 'pending',
              completed_at: null,
              due_date: todayKey,
              due_at_utc: toUtcIso(todayKey, existing.dueTime)
            },
            nowIso
          )
          break
        case 'todayDone':
          if (existing.status !== 'completed') {
            this.repo.update(id, { status: 'completed', completed_at: nowIso }, nowIso)
            // 拖拽进「今日已完成」与勾选完成语义等价，重复任务同样要续下一次
            const spawned = this.spawnNextOccurrence(existing, nowIso)
            this.replan(id)
            if (spawned) this.replan(spawned.id)
            return this.repo.findById(id)
          }
          break
      }

      this.replan(id)
      return this.repo.findById(id)
    })
  }

  update(id: string, patch: TaskPatch, now: Date = new Date()): Task | null {
    const nowIso = now.toISOString()
    return inTransaction(this.db, () => {
      const existing = this.repo.findById(id)
      if (!existing) return null

      const fields: Record<string, string | number | null> = {}
      if (patch.title !== undefined) fields.title = patch.title
      if (patch.note !== undefined) fields.note = patch.note
      if (patch.priority !== undefined) fields.priority = patch.priority

      const dueDateChanging = patch.dueDate !== undefined || patch.dueTime !== undefined
      const nextDueDate = patch.dueDate !== undefined ? patch.dueDate : existing.dueDate
      const nextDueTime = patch.dueTime !== undefined ? patch.dueTime : existing.dueTime
      if (dueDateChanging) {
        fields.due_date = nextDueDate
        fields.due_time = nextDueTime
        fields.due_at_utc = nextDueDate ? toUtcIso(nextDueDate, nextDueTime) : null
      }

      if (Object.keys(fields).length > 0) this.repo.update(id, fields, nowIso)
      if (patch.tags !== undefined) {
        this.repo.unlinkAllTags(id)
        if (patch.tags.length > 0) this.applyTags(id, patch.tags, nowIso)
      }

      // 提醒字段变更 → replan 必须跟着走，否则会出现
      // 「设置页显示改了但提醒仍是旧时刻」的中间态（§23 明确要求重新计算）
      const reminderFields: Record<string, string | number> = {}
      if (patch.reminderEnabled !== undefined) reminderFields.reminder_enabled = patch.reminderEnabled ? 1 : 0
      if (patch.reminderDays !== undefined) {
        reminderFields.reminder_days = Math.max(0, Math.floor(patch.reminderDays))
      }
      if (patch.reminderTime !== undefined) reminderFields.reminder_time = patch.reminderTime
      if (patch.notifyChannels !== undefined) reminderFields.notify_channels = patch.notifyChannels
      if (Object.keys(reminderFields).length > 0) this.repo.update(id, reminderFields, nowIso)

      // 重复规则变更（§10：默认「修改当前实例及后续重复规则」）。
      // 历史实例身上各自留着规则快照，所以这里改不到它们 —— 正是期望行为。
      if (patch.repeatRule !== undefined) {
        const nextRule = this.prepareRule(patch.repeatRule, nextDueDate)
        this.repo.update(
          id,
          {
            repeat_rule: serializeRule(nextRule),
            // 从「不重复」变成「重复」时补上 series_id；取消重复时保留旧 series_id，
            // 否则已生成的后继实例会失去串联系（历史不该被改写）
            series_id: nextRule ? existing.seriesId ?? id : existing.seriesId
          },
          nowIso
        )
      }

      this.replan(id)
      return this.repo.findById(id)
    })
  }

  remove(id: string, now: Date = new Date()): boolean {
    const nowIso = now.toISOString()
    return inTransaction(this.db, () => {
      const existing = this.repo.findById(id)
      if (!existing) return false
      this.repo.softDelete(id, nowIso)
      this.replan(id)
      return true
    })
  }

  /** 标签名 → tag 行（不存在则建），并建立关联 */
  private applyTags(taskId: string, names: string[], nowIso: string): void {
    for (const rawName of names) {
      const name = rawName.trim()
      if (!name) continue
      const existing = this.repo.findTagByName(name)
      const tagId = existing?.id ?? randomUUID()
      if (!existing) this.repo.insertTag(tagId, name, tagColorFor(name), nowIso)
      this.repo.linkTag(taskId, tagId)
    }
  }
}
