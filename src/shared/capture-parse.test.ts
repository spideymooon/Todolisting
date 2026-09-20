import { describe, expect, it } from 'vitest'
import { parseCapture } from './capture-parse'

/** 固定「现在」= 2026-09-17（周四），让断言可复现 */
const NOW = new Date(2026, 8, 17, 10, 0, 0)

const p = (raw: string, defaultTarget: 'today' | 'pool' = 'today'): ReturnType<typeof parseCapture> =>
  parseCapture(raw, { now: NOW, defaultTarget })

describe('parseCapture', () => {
  it('没有日期词时回落默认落点，并保留完整标题', () => {
    const r = p('交周报')
    expect(r.title).toBe('交周报')
    expect(r.dueDate).toBe('2026-09-17')
    expect(r.matchedDateText).toBeNull()
  })

  it('defaultTarget = pool 时不设日期', () => {
    const r = p('读会儿书', 'pool')
    expect(r.title).toBe('读会儿书')
    expect(r.dueDate).toBeNull()
  })

  it('识别「明天」并把日期词从标题里剥掉', () => {
    const r = p('明天 交周报')
    expect(r.title).toBe('交周报')
    expect(r.dueDate).toBe('2026-09-18')
    expect(r.matchedDateText).toBe('明天')
  })

  it('「后天」「大后天」优先于「后天」（长词先匹配）', () => {
    expect(p('后天 体检').dueDate).toBe('2026-09-19')
    expect(p('大后天 出差').dueDate).toBe('2026-09-20')
  })

  it('本周周几：今天周四说「周五」是明天', () => {
    const r = p('周五 复盘')
    expect(r.dueDate).toBe('2026-09-18')
    expect(r.title).toBe('复盘')
  })

  it('本周周几已过则顺延：今天周四说「周二」是下周二', () => {
    expect(p('周二 开会').dueDate).toBe('2026-09-22')
  })

  it('「下周X」落在下一个自然周，不是在最近的周X 上加天', () => {
    expect(p('下周一 开会').dueDate).toBe('2026-09-21')
    // 关键回归：今天周四，「下周五」必须是 9/25，而不是明天 9/18
    expect(p('下周五 汇报').dueDate).toBe('2026-09-25')
    expect(p('下周日 休息').dueDate).toBe('2026-09-27')
  })

  it('绝对日期 9-20 / 9/20 / 9月20日', () => {
    expect(p('9-20 交房租').dueDate).toBe('2026-09-20')
    expect(p('9/20 交房租').dueDate).toBe('2026-09-20')
    expect(p('9月20日 交房租').dueDate).toBe('2026-09-20')
    expect(p('9-20 交房租').title).toBe('交房租')
  })

  it('带年份的绝对日期不会被切碎成 26-09', () => {
    const r = p('2026-09-20 出差')
    expect(r.dueDate).toBe('2026-09-20')
    expect(r.title).toBe('出差')
  })

  it('不带年份且已过去的月/日，滚到明年', () => {
    expect(p('1-05 交保险').dueDate).toBe('2027-01-05')
  })

  it('复合词「今晚」同时给出日期和时刻', () => {
    const r = p('今晚 开会')
    expect(r.dueDate).toBe('2026-09-17')
    expect(r.dueTime).toBe('20:00')
    expect(r.title).toBe('开会')
  })

  it('「明早」= 明天 08:00', () => {
    const r = p('明早 跑步')
    expect(r.dueDate).toBe('2026-09-18')
    expect(r.dueTime).toBe('08:00')
  })

  it('时段 + 小时换算：下午3点 → 15:00，晚上8点 → 20:00', () => {
    expect(p('下午3点 面试').dueTime).toBe('15:00')
    expect(p('晚上8点 聚餐').dueTime).toBe('20:00')
    expect(p('中午12点 吃饭').dueTime).toBe('12:00')
    expect(p('9:30 站会').dueTime).toBe('09:30')
  })

  it('只给时段不给小时时用默认时刻', () => {
    expect(p('晚上 倒垃圾').dueTime).toBe('20:00')
    expect(p('早上 吃药').dueTime).toBe('08:00')
  })

  it('#标签 会被抽出、去重，并从标题里剥掉', () => {
    const r = p('后天 体检 #生活')
    expect(r.tags).toEqual(['生活'])
    expect(r.title).toBe('体检')
    expect(r.dueDate).toBe('2026-09-19')

    expect(p('写方案 #工作 #工作').tags).toEqual(['工作'])
  })

  it('N天后', () => {
    expect(p('3天后 回访客户').dueDate).toBe('2026-09-20')
  })

  it('解析不出日期不算错误，也不阻塞', () => {
    const r = p('顺便买瓶水')
    expect(r.title).toBe('顺便买瓶水')
    expect(r.dueDate).toBe('2026-09-17')
    expect(r.dueTime).toBeNull()
  })

  it('空输入返回空结果', () => {
    expect(p('   ').title).toBe('')
    expect(p('').dueDate).toBeNull()
  })

  it('整句都是日期词时，标题退化为原文，不产生空标题任务', () => {
    expect(p('明天').title).toBe('明天')
  })
})
