import type { BoardColumn, Task } from '@shared/types'

export interface ColumnDef {
  key: BoardColumn
  title: string
  empty: string
  /** null = 该列不提供快速添加入口 */
  addLabel: string | null
  /** 拖到这一列时的提示 */
  hint: string
}

/**
 * 三列定义。
 * 待办池的语义是「**未排入今天**」（无日期 或 未来到期），不是「无日期」——
 * 否则明天到期的任务会在看板上消失。
 */
export const COLUMNS: ColumnDef[] = [
  {
    key: 'pool',
    title: '待办池',
    empty: '把不重要的事先丢进来',
    addLabel: '添加到待办池',
    hint: '不设定日期'
  },
  {
    key: 'todayPending',
    title: '今日待完成',
    empty: '今天没有安排，从待办池拖一张过来',
    addLabel: '添加今日任务',
    hint: '排到今天'
  },
  {
    key: 'todayDone',
    title: '今日已完成',
    empty: '完成的任务会出现在这里',
    addLabel: null,
    hint: '标记完成'
  }
]

/** 任务当前属于哪一列 —— 必须与主进程 COLUMN_SQL 的条件完全一致 */
export function columnOf(task: Task, todayKey: string): BoardColumn {
  if (task.status === 'completed') return 'todayDone'
  if (!task.dueDate) return 'pool'
  return task.dueDate <= todayKey ? 'todayPending' : 'pool'
}

/** 已经是这一列的任务，不必再走一次写库 + 提醒重算 */
export function alreadyInColumn(task: Task, column: BoardColumn, todayKey: string): boolean {
  return columnOf(task, todayKey) === column
}

/** 列内快速添加的默认落点 */
export function defaultDueForColumn(column: BoardColumn, todayKey: string): string | null {
  return column === 'pool' ? null : todayKey
}
