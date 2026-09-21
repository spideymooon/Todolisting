import { describe, expect, it } from 'vitest'
import {
  bumpDoneCount,
  daysInMonth,
  defaultRule,
  describeRule,
  isRuleFinished,
  nextOccurrence,
  normalizeRule,
  parseRule,
  serializeRule,
  type RepeatRule
} from './repeat'

/** 构造规则的小工具：只写关心的字段，其余走默认 */
function rule(patch: Partial<RepeatRule>): RepeatRule {
  return normalizeRule({ freq: 'daily', ...patch }) as RepeatRule
}

describe('normalizeRule —— 任何坏数据都不该让列表炸掉', () => {
  it('null / undefined / 空串 → null（= 不重复）', () => {
    expect(normalizeRule(null)).toBeNull()
    expect(normalizeRule(undefined)).toBeNull()
    expect(normalizeRule('')).toBeNull()
    expect(normalizeRule('   ')).toBeNull()
  })

  it('非法 JSON 字符串 → null，不抛错', () => {
    expect(normalizeRule('{ 这不是 json')).toBeNull()
    expect(normalizeRule('123')).toBeNull()
    expect(normalizeRule('"字符串"')).toBeNull()
  })

  it('未知 freq → null', () => {
    expect(normalizeRule({ freq: '每分钟' })).toBeNull()
    expect(normalizeRule({ freq: null })).toBeNull()
  })

  it('interval 非法时回落到 1，并夹到上限', () => {
    expect(rule({ interval: 0 }).interval).toBe(1)
    expect(rule({ interval: -3 }).interval).toBe(1)
    expect(rule({ interval: 2.7 }).interval).toBe(2)
    expect(rule({ interval: Number.NaN }).interval).toBe(1)
    expect(rule({ interval: 99_999 }).interval).toBe(365)
  })

  it('weekdays 去重、排序、剔除越界值', () => {
    expect(rule({ freq: 'weekly', weekdays: [5, 1, 5, 9, -1] }).weekdays).toEqual([1, 5])
  })

  it('weekly 但没给星期 → 兜底为周一，而不是变成「每周什么也不做」', () => {
    expect(rule({ freq: 'weekly', weekdays: [] }).weekdays).toEqual([1])
  })

  it('endType=until 但日期非法 → 退化成永不（宁可多提醒也不要静默停规则）', () => {
    expect(rule({ endType: 'until', endDate: null }).endType).toBe('never')
    expect(rule({ endType: 'until', endDate: '2026/12/31' }).endType).toBe('never')
    expect(rule({ endType: 'until', endDate: '2026-12-31' }).endType).toBe('until')
  })

  it('endCount 至少为 2 —— 1 意味着「只发生这一次」，那就不该建重复规则', () => {
    expect(rule({ endType: 'count', endCount: 0 }).endCount).toBe(2)
    expect(rule({ endType: 'count', endCount: -5 }).endCount).toBe(2)
    expect(rule({ endType: 'count', endCount: 1 }).endCount).toBe(2)
    expect(rule({ endType: 'count', endCount: 5 }).endCount).toBe(5)
  })

  it('序列化 → 解析往返后等价', () => {
    const original = rule({ freq: 'weekly', weekdays: [1, 3, 5], endType: 'count', endCount: 8 })
    expect(parseRule(serializeRule(original))).toEqual(original)
  })

  it('serializeRule(null) → null（数据库存 NULL，不是字符串 "null"）', () => {
    expect(serializeRule(null)).toBeNull()
    expect(serializeRule(undefined)).toBeNull()
  })

  it('数据库里的脏字符串 → null', () => {
    expect(parseRule('乱码')).toBeNull()
    expect(parseRule(null)).toBeNull()
  })
})

describe('daysInMonth', () => {
  it('平年 2 月 28 天，闰年 29 天', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
  })

  it('大小月正确', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})

describe('每天', () => {
  it('顺延一天', () => {
    expect(nextOccurrence(rule({ freq: 'daily' }), '2026-09-17')).toBe('2026-09-18')
  })

  it('跨月跨年', () => {
    expect(nextOccurrence(rule({ freq: 'daily' }), '2026-09-30')).toBe('2026-10-01')
    expect(nextOccurrence(rule({ freq: 'daily' }), '2026-12-31')).toBe('2027-01-01')
  })

  it('每 N 天', () => {
    expect(nextOccurrence(rule({ freq: 'daily', interval: 3 }), '2026-09-17')).toBe('2026-09-20')
  })
})

describe('每个工作日', () => {
  it('周四 → 周五', () => {
    expect(nextOccurrence(rule({ freq: 'weekday' }), '2026-09-17')).toBe('2026-09-18')
  })

  it('★ 周五 → 下周一（跨周末，§16 必测项）', () => {
    expect(nextOccurrence(rule({ freq: 'weekday' }), '2026-09-18')).toBe('2026-09-21')
  })

  it('周六 → 周一', () => {
    expect(nextOccurrence(rule({ freq: 'weekday' }), '2026-09-19')).toBe('2026-09-21')
  })

  it('周日 → 周一', () => {
    expect(nextOccurrence(rule({ freq: 'weekday' }), '2026-09-20')).toBe('2026-09-21')
  })

  it('连续推进 5 次不会落在周末', () => {
    let cursor = '2026-09-17'
    for (let i = 0; i < 5; i++) {
      cursor = nextOccurrence(rule({ freq: 'weekday' }), cursor) as string
      const day = new Date(cursor + 'T00:00:00').getDay()
      expect(day).not.toBe(0)
      expect(day).not.toBe(6)
    }
  })
})

describe('每周', () => {
  it('★ 按当前截止日的星期几算：周四 → 下周四', () => {
    // 2026-09-17 是周四
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [4] }), '2026-09-17')).toBe('2026-09-24')
  })

  it('同周内还有更晚的星期 → 就近前进，不跳整周', () => {
    // 周一(1) 之后，本周还有周三(3)
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1, 3] }), '2026-09-21')).toBe(
      '2026-09-23'
    )
  })

  it('同周内没有更晚的星期 → 绕到下周第一个', () => {
    // 周三(3) 之后，本周只剩…没有；下周第一个是周一(1)
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1, 3] }), '2026-09-23')).toBe(
      '2026-09-28'
    )
  })

  it('周日是 0，排在周一之前 —— 周一之后不该在同周回到周日', () => {
    // 周一(1) 之后同周没有周日，绕到 2026-09-27（周日）
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [0, 1] }), '2026-09-21')).toBe(
      '2026-09-27'
    )
  })

  it('每 2 周：同周无更晚星期时，绕到「两周后」的第一个', () => {
    // 2026-09-21 周一 → 下个周一 09-28 是 2 周里的第二周起点，但 interval=2 应跳 10-05
    expect(nextOccurrence(rule({ freq: 'weekly', weekdays: [1], interval: 2 }), '2026-09-21')).toBe(
      '2026-10-05'
    )
  })

  it('推进结果永远严格晚于基准日', () => {
    const r = rule({ freq: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] })
    let cursor = '2026-09-17'
    for (let i = 0; i < 10; i++) {
      const next = nextOccurrence(r, cursor) as string
      expect(next > cursor).toBe(true)
      cursor = next
    }
  })
})

describe('每月', () => {
  it('正常推进：17 日 → 下月 17 日', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-09-17')).toBe('2026-10-17')
  })

  it('★ 月末收敛：1月31日 → 2月最后一天（§16 必测项）', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-01-31')).toBe('2026-02-28')
  })

  it('★ 闰年 1月31日 → 2月29日', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2024-01-31')).toBe('2024-02-29')
  })

  it('★ 2月28日（非闰年）→ 3月28日，不会溢出到 3月31日', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-02-28')).toBe('2026-03-28')
  })

  it('31 日的规则跨过多个月仍然收敛，且不丢「31 日」的意图', () => {
    let cursor = '2026-01-31'
    expect(nextOccurrence(rule({ freq: 'monthly' }), cursor)).toBe('2026-02-28')
    cursor = '2026-02-28'
    expect(nextOccurrence(rule({ freq: 'monthly' }), cursor)).toBe('2026-03-28')
    // 3月28日 → 4月28日。注意：不会「记住」原本是 31 日 —— 规则基准是当前实例的日期，
    // 这与 §4「每月按当前截止日的『日』」一致
    cursor = '2026-03-28'
    expect(nextOccurrence(rule({ freq: 'monthly' }), cursor)).toBe('2026-04-28')
  })

  it('每 3 个月', () => {
    expect(nextOccurrence(rule({ freq: 'monthly', interval: 3 }), '2026-09-17')).toBe('2026-12-17')
  })

  it('跨年', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-12-17')).toBe('2027-01-17')
  })

  it('12 月 31 日 → 次年 1 月 31 日', () => {
    expect(nextOccurrence(rule({ freq: 'monthly' }), '2026-12-31')).toBe('2027-01-31')
  })
})

describe('每年', () => {
  it('按同样的月/日推进', () => {
    expect(nextOccurrence(rule({ freq: 'yearly' }), '2026-09-17')).toBe('2027-09-17')
  })

  it('★ 闰日收敛：2024-02-29 → 2025-02-28（§16 必测项）', () => {
    expect(nextOccurrence(rule({ freq: 'yearly' }), '2024-02-29')).toBe('2025-02-28')
  })

  it('每 2 年', () => {
    expect(nextOccurrence(rule({ freq: 'yearly', interval: 2 }), '2026-09-17')).toBe('2028-09-17')
  })
})

describe('自定义 每 N 天 / 周 / 月', () => {
  it('每 2 周', () => {
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'week', interval: 2 }), '2026-09-17')).toBe(
      '2026-10-01'
    )
  })

  it('每 10 天', () => {
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'day', interval: 10 }), '2026-09-17')).toBe(
      '2026-09-27'
    )
  })

  it('每 2 个月（月末也会收敛）', () => {
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'month', interval: 2 }), '2026-01-31')).toBe(
      '2026-03-31'
    )
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'month', interval: 2 }), '2026-08-31')).toBe(
      '2026-10-31'
    )
  })

  it('custom 的 interval = 1 等价于基础频率', () => {
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'day', interval: 1 }), '2026-09-17')).toBe(
      '2026-09-18'
    )
    expect(nextOccurrence(rule({ freq: 'custom', unit: 'week', interval: 1 }), '2026-09-17')).toBe(
      '2026-09-24'
    )
  })
})

describe('结束条件', () => {
  it('until：下一次超过 endDate 就停', () => {
    const r = rule({ freq: 'daily', endType: 'until', endDate: '2026-09-19' })
    expect(nextOccurrence(r, '2026-09-18')).toBe('2026-09-19')
    expect(nextOccurrence(r, '2026-09-19')).toBeNull()
  })

  it('until：endDate 当天仍会发生（含当天）', () => {
    const r = rule({ freq: 'daily', endType: 'until', endDate: '2026-09-18' })
    expect(nextOccurrence(r, '2026-09-17')).toBe('2026-09-18')
    expect(nextOccurrence(r, '2026-09-18')).toBeNull()
  })

  it('count：达到次数后停', () => {
    const r = rule({ freq: 'daily', endType: 'count', endCount: 3, doneCount: 2 })
    expect(nextOccurrence(r, '2026-09-17')).toBe('2026-09-18')
    expect(nextOccurrence(bumpDoneCount(r), '2026-09-18')).toBeNull()
  })

  it('count 收敛到最小 2 次：endCount=1 被规格化为 2，因此还能再生成一次', () => {
    const r = rule({ freq: 'daily', endType: 'count', endCount: 1, doneCount: 1 })
    expect(r.endCount).toBe(2)
    expect(nextOccurrence(r, '2026-09-17')).toBe('2026-09-18')
    // 到第 2 次就真的停了
    expect(nextOccurrence(bumpDoneCount(r), '2026-09-18')).toBeNull()
  })

  it('isRuleFinished 对 never 永远 false', () => {
    expect(isRuleFinished(rule({ endType: 'never' }), '2099-12-31')).toBe(false)
  })

  it('bumpDoneCount 不改动其它字段', () => {
    const r = rule({ freq: 'weekly', weekdays: [1], endType: 'count', endCount: 5, doneCount: 2 })
    expect(bumpDoneCount(r)).toEqual({ ...r, doneCount: 3 })
  })
})

describe('边界与防御', () => {
  it('规则为 null → null（不重复任务永不生成下一次）', () => {
    expect(nextOccurrence(null, '2026-09-17')).toBeNull()
  })

  it('基准日为 null / 非法 → null', () => {
    expect(nextOccurrence(rule({}), null)).toBeNull()
    expect(nextOccurrence(rule({}), '2026/09/17')).toBeNull()
    expect(nextOccurrence(rule({}), '')).toBeNull()
  })

  it('穷举一年的每天：任何规则的推进结果都严格向后（不会原地打转）', () => {
    const rules = [
      rule({ freq: 'daily' }),
      rule({ freq: 'weekday' }),
      rule({ freq: 'weekly', weekdays: [1, 3, 5] }),
      rule({ freq: 'monthly' }),
      rule({ freq: 'yearly' }),
      rule({ freq: 'custom', unit: 'month', interval: 2 })
    ]
    let cursor = '2026-01-01'
    for (let i = 0; i < 365; i++) {
      for (const r of rules) {
        const next = nextOccurrence(r, cursor)
        expect(next).not.toBeNull()
        expect((next as string) > cursor).toBe(true)
      }
      cursor = nextOccurrence(rules[0], cursor) as string
    }
  })
})

describe('describeRule —— 给用户看的文案', () => {
  it('基础频率', () => {
    expect(describeRule(rule({ freq: 'daily' }))).toBe('每天')
    expect(describeRule(rule({ freq: 'weekday' }))).toBe('每个工作日')
    expect(describeRule(rule({ freq: 'monthly' }))).toBe('每月')
    expect(describeRule(rule({ freq: 'yearly' }))).toBe('每年')
  })

  it('每周列出星期几', () => {
    expect(describeRule(rule({ freq: 'weekly', weekdays: [1] }))).toBe('每周一')
    expect(describeRule(rule({ freq: 'weekly', weekdays: [1, 3, 5] }))).toBe('每周一、周三、周五')
  })

  it('间隔大于 1 时显式写出', () => {
    expect(describeRule(rule({ freq: 'daily', interval: 3 }))).toBe('每 3 天')
    expect(describeRule(rule({ freq: 'weekly', weekdays: [2], interval: 2 }))).toBe('每 2 周周二')
    expect(describeRule(rule({ freq: 'custom', unit: 'month', interval: 2 }))).toBe('每 2 个月')
  })

  it('null 规则返回空串', () => {
    expect(describeRule(null)).toBe('')
  })
})

describe('defaultRule', () => {
  it('默认每天、永不结束、已发生 1 次', () => {
    const r = defaultRule('daily')
    expect(r.freq).toBe('daily')
    expect(r.endType).toBe('never')
    expect(r.doneCount).toBe(1)
  })

  it('给了基准日时，weekly 的默认星期 = 该日期的星期', () => {
    // 2026-09-17 是周四 = 4
    expect(defaultRule('weekly', '2026-09-17').weekdays).toEqual([4])
  })
})
