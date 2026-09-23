import { describe, expect, it } from 'vitest'
import { weekdayIndex } from './date'
import { daysInMonth, monthGrid } from './calendar-grid'

/** 断言一份网格的通用不变式（对任何月份都该成立） */
function expectInvariants(cells: ReturnType<typeof monthGrid>, year: number, month: number): void {
  // 1. 行数是 7 的倍数，每行首格都是周一
  expect(cells.length % 7).toBe(0)
  for (let i = 0; i < cells.length; i += 7) {
    expect(weekdayIndex(cells[i].key)).toBe(1)
  }
  // 2. 覆盖显示月的每一天恰好一次，且 inMonth 标记与之相符
  const total = daysInMonth(year, month)
  const inMonthKeys = cells.filter((c) => c.inMonth).map((c) => c.key)
  expect(inMonthKeys.length).toBe(total)
  const expected = Array.from({ length: total }, (_, i) => {
    const d = new Date(year, month - 1, i + 1)
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${year}-${pad(month)}-${pad(d.getDate())}`
  })
  expect(inMonthKeys).toEqual(expected)
  // 3. 补位格（首尾）确实不属于显示月；头部 0~6 格、尾部 0~6 格
  const firstIn = cells.findIndex((c) => c.inMonth)
  const lastIn = cells.map((c) => c.inMonth).lastIndexOf(true)
  expect(firstIn).toBeGreaterThanOrEqual(0)
  expect(firstIn).toBeLessThan(7)
  expect(cells.length - 1 - lastIn).toBeLessThan(7)
  for (const c of [...cells.slice(0, firstIn), ...cells.slice(lastIn + 1)]) {
    expect(c.inMonth).toBe(false)
  }
}

describe('daysInMonth', () => {
  it('平年二月 28 天，闰年二月 29 天', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
  })

  it('大小月', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})

describe('monthGrid', () => {
  it('2026-09：1 日是周二，首格 8-31，5 行 35 格，末格 10-04', () => {
    const cells = monthGrid(2026, 9)
    expect(cells.length).toBe(35)
    expect(cells[0]).toEqual({ key: '2026-08-31', day: 31, inMonth: false })
    expect(cells[1]).toEqual({ key: '2026-09-01', day: 1, inMonth: true })
    expect(cells[30]).toEqual({ key: '2026-09-30', day: 30, inMonth: true })
    expect(cells[31]).toEqual({ key: '2026-10-01', day: 1, inMonth: false })
    expect(cells[34]).toEqual({ key: '2026-10-04', day: 4, inMonth: false })
    expectInvariants(cells, 2026, 9)
  })

  it('2026-02：1 日是周日（整行补位），28 天仍占 5 行', () => {
    const cells = monthGrid(2026, 2)
    expect(cells.length).toBe(35)
    expect(cells[0]).toEqual({ key: '2026-01-26', day: 26, inMonth: false })
    expect(cells[6]).toEqual({ key: '2026-02-01', day: 1, inMonth: true })
    expect(cells[34]).toEqual({ key: '2026-03-01', day: 1, inMonth: false })
    expectInvariants(cells, 2026, 2)
  })

  it('2024-02：闰年 29 天', () => {
    const cells = monthGrid(2024, 2)
    expect(cells.length).toBe(35)
    expect(cells.some((c) => c.key === '2024-02-29' && c.inMonth)).toBe(true)
    expectInvariants(cells, 2024, 2)
  })

  it('2026-08：1 日是周六，需要 6 行 42 格（最多行数的月份）', () => {
    const cells = monthGrid(2026, 8)
    expect(cells.length).toBe(42)
    expect(cells[0]).toEqual({ key: '2026-07-27', day: 27, inMonth: false })
    expect(cells[5]).toEqual({ key: '2026-08-01', day: 1, inMonth: true })
    expect(cells[41]).toEqual({ key: '2026-09-06', day: 6, inMonth: false })
    expectInvariants(cells, 2026, 8)
  })

  it('2026-12：跨年到下一年 1 月补位', () => {
    const cells = monthGrid(2026, 12)
    expect(cells[0]).toEqual({ key: '2026-11-30', day: 30, inMonth: false })
    expect(cells[cells.length - 1]).toEqual({ key: '2027-01-03', day: 3, inMonth: false })
    expectInvariants(cells, 2026, 12)
  })

  it('2027-02：1 日恰好是周一，不需要头部补位', () => {
    const cells = monthGrid(2027, 2)
    expect(cells[0]).toEqual({ key: '2027-02-01', day: 1, inMonth: true })
    expectInvariants(cells, 2027, 2)
  })

  it('全年 12 个月都满足不变式（闰年 2024）', () => {
    for (let m = 1; m <= 12; m++) {
      expectInvariants(monthGrid(2024, m), 2024, m)
    }
  })
})
