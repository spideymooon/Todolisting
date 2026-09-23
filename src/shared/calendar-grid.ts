/**
 * 月历视图的网格生成（「日历」页专用，纯函数、无 IPC 依赖）。
 *
 * 规则（《TodoList-今天页面改为月历视图》）：
 * - 一周从周一开始，显示周一～周日 7 列
 * - 完整月视图：首尾用上月 / 下月日期补位，凑满整行
 * - 行数按实际需要 5～6 行（有的月份 4 周多一点就放得下，5 行铺得更满），
 *   不固定 6 行 —— 那样 5 行月份的每格会被压矮
 * - 28 / 29 / 30 / 31 天与闰年、跨月跨年全部交给本地 Date 处理，
 *   不手写月长表（手写必然在某年二月翻车）
 *
 * 时间约定与 @shared/date 一致：全部走「本地日历日」YYYY-MM-DD。
 */

import { addDays, toDateKey } from './date'

export interface CalendarGridCell {
  /** 本地日历日 `YYYY-MM-DD` */
  key: string
  /** 几号（1-31） */
  day: number
  /** 是否属于正在显示的月份（false = 上月 / 下月补位格，UI 上弱化） */
  inMonth: boolean
}

/** 某月天数。month 传 1-12；`new Date(y, 12, 0)` 自动落到 12 月 31 日 */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * 生成某月的完整网格（7 的倍数个格子，行间首格必为周一）。
 * month 传 1-12（与人读的月份一致，避免调用方 +1 -1 来回换算）。
 */
export function monthGrid(year: number, month: number): CalendarGridCell[] {
  const first = new Date(year, month - 1, 1)
  // JS 的 getDay() 0=周日；周一开头的网格里，周一是第 0 列
  const lead = (first.getDay() + 6) % 7
  const total = daysInMonth(year, month)
  const rows = Math.ceil((lead + total) / 7)

  const cells: CalendarGridCell[] = []
  for (let i = 0; i < rows * 7; i++) {
    const d = addDays(first, i - lead)
    cells.push({ key: toDateKey(d), day: d.getDate(), inMonth: i >= lead && i < lead + total })
  }
  return cells
}
