/**
 * 纯 SQL 读写层。只负责「行 ↔ 领域对象」的翻译，不含任何业务判断。
 * 不 import Electron，不 import 上层 service。
 */

import type { Db } from '../database/connection'
import type { BoardColumn, NotifyChannel, Priority, Tag, TagColor, Task, TaskStatus } from '@shared/types'
import { toDateKey } from '@shared/date'

interface TaskRow {
  id: string
  title: string
  note: string | null
  status: string
  priority: number
  due_date: string | null
  due_time: string | null
  due_at_utc: string | null
  reminder_enabled: number
  reminder_days: number
  reminder_time: string
  notify_channels: string
  completed_at: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

interface TagRow {
  id: string
  name: string
  color: string
}

interface TagJoinRow extends TagRow {
  task_id: string
}

const TAG_PALETTE: TagColor[] = ['red', 'green', 'blue', 'amber', 'purple', 'gray']

/** 同一个标签名永远得到同一个颜色，不依赖建表顺序 */
export function tagColorFor(name: string): TagColor {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 100_000
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length]
}

function mapTask(row: TaskRow, tags: Tag[]): Task {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    dueDate: row.due_date,
    dueTime: row.due_time,
    dueAtUtc: row.due_at_utc,
    // SQLite 没有布尔类型，INTEGER 0/1 在这里收敛成 boolean，上层就再也不用管它
    reminderEnabled: row.reminder_enabled === 1,
    reminderDays: Number(row.reminder_days ?? 1),
    reminderTime: row.reminder_time ?? '09:00',
    notifyChannels: (row.notify_channels ?? 'desktop') as NotifyChannel,
    completedAt: row.completed_at,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags
  }
}

/**
 * 三列的 SQL 条件 —— 看板不是新概念，就是这三个查询（《00-架构设计》§13.2）
 *
 * ⚠ v1 修正：原定义里 pool 只收 `due_date IS NULL`，这会让「明天到期」的任务
 * 在看板上**凭空消失**（既不在 pool 也不在 today）。现改为
 * `due_date IS NULL OR due_date > today`，即「**未排入今天**的都先待在待办池」，
 * 看板因此成为所有未完成任务的完整视图。
 *
 * todayPending 用 `due_date <= ?`：逾期任务要浮到「今日待完成」列顶部。
 */
const COLUMN_SQL: Record<BoardColumn, string> = {
  pool: `deleted_at IS NULL AND is_template = 0 AND status = 'pending'
         AND (due_date IS NULL OR due_date > ?)
         ORDER BY CASE WHEN due_date IS NULL THEN 0 ELSE 1 END, due_date ASC, priority ASC, created_at DESC`,
  todayPending: `deleted_at IS NULL AND is_template = 0 AND due_date IS NOT NULL
                 AND due_date <= ? AND status = 'pending'
                 ORDER BY CASE WHEN due_date < ? THEN 0 ELSE 1 END, priority ASC, created_at ASC`,
  todayDone: `deleted_at IS NULL AND is_template = 0 AND due_date = ? AND status = 'completed'
              ORDER BY completed_at DESC`
}

const COLUMN_PARAMS: Record<BoardColumn, (todayKey: string) => BindParams> = {
  pool: (t) => [t],
  todayPending: (t) => [t, t],
  todayDone: (t) => [t]
}

/** node-sqlite3-wasm 只接受 JSValue[]，不能用 unknown[] 兜底 */
type BindParams = Array<string | number | null>

export interface InsertTaskRow {
  id: string
  title: string
  note: string | null
  priority: Priority
  dueDate: string | null
  dueTime: string | null
  dueAtUtc: string | null
  reminderEnabled: boolean
  reminderDays: number
  reminderTime: string
  notifyChannels: NotifyChannel
  now: string
}

export class TaskRepository {
  constructor(private readonly db: Db) {}

  findTasksByColumn(column: BoardColumn, todayKey: string): Task[] {
    const rows = this.db.all(
      `SELECT * FROM tasks WHERE ${COLUMN_SQL[column]}`,
      COLUMN_PARAMS[column](todayKey)
    ) as unknown as TaskRow[]
    return this.attachTags(rows)
  }

  /** 今天页 / 即将到期 / 小组件窗口 / 全部 / 已完成 用到的通用查询 */
  findTasks(
    scope: 'upcoming' | 'window' | 'all' | 'completed' | 'today',
    todayKey: string,
    limit = 500,
    windowEndKey?: string
  ): Task[] {
    let where: string
    let params: BindParams
    switch (scope) {
      case 'upcoming':
        where = `deleted_at IS NULL AND is_template = 0 AND status = 'pending'
                 AND due_date IS NOT NULL AND due_date > ?
                 ORDER BY due_date ASC, due_at_utc ASC`
        params = [todayKey]
        break
      case 'window':
        // 桌面小组件（§14.4）：逾期 + 今天 + 未来两天，即 due_date <= 今天+2。
        // 逾期项没有下界 —— 就是故意让它们一直挂在那儿提醒你，直到被拖走或完成。
        //
        // 排序两个坑：
        //  1. 逾期排最前 → CASE WHEN due_date < today THEN 0 ELSE 1
        //  2. 判「有没有时刻」必须用 due_time，不能看 due_at_utc ——
        //     没有时刻时 toUtcIso 会补成当天 00:00（不是 NULL），
        //     直接按 due_at_utc 排会把「今天」这种无时刻任务排到「今天 09:00」前面。
        where = `deleted_at IS NULL AND is_template = 0 AND status = 'pending'
                 AND due_date IS NOT NULL AND due_date <= ?
                 ORDER BY CASE WHEN due_date < ? THEN 0 ELSE 1 END,
                          due_date ASC,
                          CASE WHEN due_time IS NULL THEN 1 ELSE 0 END,
                          due_time ASC`
        params = [windowEndKey ?? todayKey, todayKey]
        break
      case 'all':
        where = `deleted_at IS NULL AND is_template = 0
                 ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC, created_at DESC`
        params = []
        break
      case 'completed':
        where = `deleted_at IS NULL AND is_template = 0 AND status = 'completed'
                 ORDER BY completed_at DESC`
        params = []
        break
      case 'today':
      default:
        // 今天页与看板「今日待完成」展示同一批数据（§5.7），这里刻意复用同一条件
        where = `deleted_at IS NULL AND is_template = 0 AND status = 'pending'
                 AND due_date IS NOT NULL AND due_date <= ?
                 ORDER BY CASE WHEN due_date < ? THEN 0 ELSE 1 END, priority ASC, created_at ASC`
        params = [todayKey, todayKey]
        break
    }
    const rows = this.db.all(
      `SELECT * FROM tasks WHERE ${where} LIMIT ${Math.floor(limit)}`,
      params
    ) as unknown as TaskRow[]
    return this.attachTags(rows)
  }

  /**
   * 全局搜索（工具栏放大镜入口）：标题 + 备注 LIKE 匹配，未完成在前。
   * 用户输入里的 % _ 会被转义，避免通配符注入导致全表命中。
   */
  search(query: string, limit = 50): Task[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    const q = '%' + trimmed.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const rows = this.db.all(
      `SELECT * FROM tasks
        WHERE deleted_at IS NULL AND is_template = 0
          AND (title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT ${Math.floor(limit)}`,
      [q, q]
    ) as unknown as TaskRow[]
    return this.attachTags(rows)
  }

  findById(id: string): Task | null {
    const row = this.db.get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', [id]) as
      | unknown as TaskRow
      | undefined
    if (!row) return null
    return this.attachTags([row])[0] ?? null
  }

  /**
   * 全量重排（启动时、系统时间跳变时）要遍历的任务 id。
   * 只取未完成的 —— 已完成的任务不该有任何提醒计划。
   */
  allPendingIds(): string[] {
    const rows = this.db.all(
      `SELECT id FROM tasks
        WHERE deleted_at IS NULL AND is_template = 0 AND status = 'pending'`
    ) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  }

  insert(input: InsertTaskRow): void {
    this.db.run(
      `INSERT INTO tasks
         (id, title, note, status, priority, due_date, due_time, due_at_utc,
          reminder_enabled, reminder_days, reminder_time, notify_channels,
          sort_order, is_template, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        input.id,
        input.title,
        input.note,
        input.priority,
        input.dueDate,
        input.dueTime,
        input.dueAtUtc,
        input.reminderEnabled ? 1 : 0,
        input.reminderDays,
        input.reminderTime,
        input.notifyChannels,
        input.now,
        input.now
      ]
    )
  }

  /** 局部更新。只允许白名单字段，字段名不经用户输入 */
  update(id: string, fields: Record<string, string | number | null>, now: string): void {
    const allowed = [
      'title',
      'note',
      'priority',
      'due_date',
      'due_time',
      'due_at_utc',
      'status',
      'completed_at',
      'reminder_enabled',
      'reminder_days',
      'reminder_time',
      'notify_channels'
    ]
    const keys = Object.keys(fields).filter((k) => allowed.includes(k))
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    this.db.run(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`, [
      ...keys.map((k) => fields[k]),
      now,
      id
    ])
  }

  softDelete(id: string, now: string): void {
    this.db.run('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, id])
  }

  /** 按列计数，供侧栏红点/数字使用 */
  counts(todayKey: string): {
    todayCount: number
    overdueCount: number
    boardCount: number
    upcomingCount: number
    allCount: number
    completedCount: number
  } {
    const one = (sql: string, params: BindParams = []): number => {
      const row = this.db.get(sql, params) as unknown as { n?: number } | undefined
      return Number(row?.n ?? 0)
    }
    const base = 'deleted_at IS NULL AND is_template = 0'
    return {
      todayCount: one(
        `SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending' AND due_date IS NOT NULL AND due_date <= ?`,
        [todayKey]
      ),
      overdueCount: one(
        `SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending' AND due_date IS NOT NULL AND due_date < ?`,
        [todayKey]
      ),
      boardCount: one(
        `SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending'
           AND (due_date IS NULL OR due_date > ?)`,
        [todayKey]
      ) + one(
        `SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending'
           AND due_date IS NOT NULL AND due_date <= ?`,
        [todayKey]
      ),
      upcomingCount: one(
        `SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending' AND due_date > ?`,
        [todayKey]
      ),
      allCount: one(`SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='pending'`),
      completedCount: one(`SELECT COUNT(*) AS n FROM tasks WHERE ${base} AND status='completed'`)
    }
  }

  // ── 标签 ──────────────────────────────────────────────

  allTags(): Tag[] {
    const rows = this.db.all('SELECT id, name, color FROM tags ORDER BY name ASC') as unknown as TagRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color as TagColor }))
  }

  findTagByName(name: string): Tag | null {
    const row = this.db.get('SELECT id, name, color FROM tags WHERE name = ?', [name]) as
      | unknown as TagRow
      | undefined
    return row ? { id: row.id, name: row.name, color: row.color as TagColor } : null
  }

  insertTag(id: string, name: string, color: TagColor, now: string): void {
    this.db.run('INSERT OR IGNORE INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)', [
      id,
      name,
      color,
      now
    ])
  }

  linkTag(taskId: string, tagId: string): void {
    this.db.run('INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)', [taskId, tagId])
  }

  unlinkAllTags(taskId: string): void {
    this.db.run('DELETE FROM task_tags WHERE task_id = ?', [taskId])
  }

  private attachTags(rows: TaskRow[]): Task[] {
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    const tagRows = this.db.all(
      `SELECT tt.task_id, t.id, t.name, t.color
         FROM task_tags tt
         JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id IN (${placeholders})
        ORDER BY t.name ASC`,
      ids
    ) as unknown as TagJoinRow[]

    const byTask = new Map<string, Tag[]>()
    for (const tr of tagRows) {
      const list = byTask.get(tr.task_id) ?? []
      list.push({ id: tr.id, name: tr.name, color: tr.color as TagColor })
      byTask.set(tr.task_id, list)
    }

    return rows.map((r) => mapTask(r, byTask.get(r.id) ?? []))
  }
}

export { toDateKey }
