import { describe, expect, it } from 'vitest'
import {
  describeRemaining,
  effectiveChannel,
  nextReminderAt,
  type ReminderDefaults,
  type ReminderTask
} from './reminder-plan'

/** 2026-09-17 周四 10:00 */
const NOW = new Date(2026, 8, 17, 10, 0, 0)

const DEFAULTS: ReminderDefaults = {
  overduePolicy: 'once',
  desktopNotifyEnabled: true,
  wechatNotifyEnabled: false
}

function task(over: Partial<ReminderTask> = {}): ReminderTask {
  return {
    title: '提交周报',
    status: 'pending',
    dueDate: '2026-09-20',
    dueTime: null,
    reminderEnabled: true,
    reminderDays: 2,
    reminderTime: '09:00',
    notifyChannels: 'desktop',
    ...over
  }
}

/** 本地时刻 → 期望的 UTC ISO */
function local(y: number, m: number, d: number, h: number, min: number): string {
  return new Date(y, m - 1, d, h, min, 0, 0).toISOString()
}

describe('nextReminderAt —— 需求原文示例', () => {
  it('截止 2026-09-20 18:00、提前 2 天、提醒 09:00 → 2026-09-18 09:00 触发', () => {
    const plan = nextReminderAt(
      task({ dueDate: '2026-09-20', dueTime: '18:00', reminderDays: 2, reminderTime: '09:00' }),
      DEFAULTS,
      NOW,
      't1'
    )
    expect(plan).not.toBeNull()
    expect(plan?.executeAtUtc).toBe(local(2026, 9, 18, 9, 0))
    expect(plan?.reason).toBe('scheduled')
    expect(plan?.type).toBe('reminder')
    expect(plan?.daysLeft).toBe(3)
  })
})

describe('nextReminderAt —— 短路守卫', () => {
  it('已完成 → 不提醒（§5）', () => {
    expect(nextReminderAt(task({ status: 'completed' }), DEFAULTS, NOW, 't')).toBeNull()
  })

  it('没有截止日期 → 不提醒（没有锚点）', () => {
    expect(nextReminderAt(task({ dueDate: null }), DEFAULTS, NOW, 't')).toBeNull()
  })

  it('任务关掉了提醒 → 不提醒', () => {
    expect(nextReminderAt(task({ reminderEnabled: false }), DEFAULTS, NOW, 't')).toBeNull()
  })

  it('两个通道都关着 → 不提醒', () => {
    const off: ReminderDefaults = {
      overduePolicy: 'once',
      desktopNotifyEnabled: false,
      wechatNotifyEnabled: false
    }
    expect(nextReminderAt(task(), off, NOW, 't')).toBeNull()
  })

  it('全局关掉桌面但任务选了桌面 → 不提醒（全局开关是交集）', () => {
    const off: ReminderDefaults = {
      overduePolicy: 'once',
      desktopNotifyEnabled: false,
      wechatNotifyEnabled: true
    }
    expect(nextReminderAt(task({ notifyChannels: 'desktop' }), off, NOW, 't')).toBeNull()
    expect(nextReminderAt(task({ notifyChannels: 'both' }), off, NOW, 't')?.channel).toBe('wechat')
  })
})

describe('nextReminderAt —— 补发（需求评审问题 1 的修复）', () => {
  it('临期才记下来 → 立刻补发，而不是永远不提醒', () => {
    // 9-17 才记「明天交周报」，提前 2 天 → 意图时刻 9-16 09:00 早已过去
    const plan = nextReminderAt(
      task({ dueDate: '2026-09-18', reminderDays: 2 }),
      DEFAULTS,
      NOW,
      't1'
    )
    expect(plan?.reason).toBe('catch-up')
    expect(plan?.intentAt).toBe('2026-09-16T09:00')
    // 执行时刻 = 现在 + 30s
    expect(plan?.executeAtUtc).toBe(new Date(NOW.getTime() + 30_000).toISOString())
    expect(plan?.daysLeft).toBe(1)
  })

  it('plan_key 用「意图时刻」而不是「执行时刻」—— 这是防重复的根基', () => {
    const t = task({ dueDate: '2026-09-18', reminderDays: 2 })
    const a = nextReminderAt(t, DEFAULTS, NOW, 't1')
    const later = new Date(NOW.getTime() + 5 * 60_000)
    const b = nextReminderAt(t, DEFAULTS, later, 't1')

    expect(a?.executeAtUtc).not.toBe(b?.executeAtUtc) // 执行时刻每次都不同
    expect(a?.planKey).toBe(b?.planKey) // 但计划键必须一样
    expect(a?.planKey).toBe('t1|reminder|2026-09-16T09:00')
  })

  it('今天到期、没写具体时刻 → 刻意不补发，避免记一条弹一个通知', () => {
    const plan = nextReminderAt(
      task({ dueDate: '2026-09-17', dueTime: null, reminderDays: 0, reminderTime: '09:00' }),
      DEFAULTS,
      NOW,
      't'
    )
    expect(plan).toBeNull()
  })

  it('今天到期、写了 18:00 且还没到 → 补发一次', () => {
    const plan = nextReminderAt(
      task({ dueDate: '2026-09-17', dueTime: '18:00', reminderDays: 0, reminderTime: '09:00' }),
      DEFAULTS,
      NOW,
      't'
    )
    expect(plan?.reason).toBe('catch-up')
  })
})

describe('nextReminderAt —— 逾期（§24）', () => {
  it('逾期且策略为「补一次」→ 生成 overdue 计划', () => {
    const plan = nextReminderAt(task({ dueDate: '2026-09-15' }), DEFAULTS, NOW, 't1')
    expect(plan?.type).toBe('overdue')
    expect(plan?.reason).toBe('overdue')
    expect(plan?.daysLeft).toBe(-2)
    // 逾期计划的键按截止日固定：同一个截止日只会补一次，重启也不会重复
    expect(plan?.planKey).toBe('t1|overdue|overdue:2026-09-15')
  })

  it('逾期且策略为「不再提醒」→ null', () => {
    const never: ReminderDefaults = { ...DEFAULTS, overduePolicy: 'never' }
    expect(nextReminderAt(task({ dueDate: '2026-09-15' }), never, NOW, 't')).toBeNull()
  })
})

describe('nextReminderAt —— 收敛：提醒不得晚于截止', () => {
  it('提醒时刻 09:00 晚于截止 08:00 → 收敛到 08:00', () => {
    const plan = nextReminderAt(
      task({ dueDate: '2026-09-18', dueTime: '08:00', reminderDays: 0, reminderTime: '09:00' }),
      DEFAULTS,
      NOW,
      't'
    )
    expect(plan?.executeAtUtc).toBe(local(2026, 9, 18, 8, 0))
    expect(plan?.reason).toBe('scheduled')
  })
})

describe('effectiveChannel', () => {
  const bothOn: ReminderDefaults = {
    overduePolicy: 'once',
    desktopNotifyEnabled: true,
    wechatNotifyEnabled: true
  }

  it('任务选择 ∩ 全局开关', () => {
    expect(effectiveChannel(task({ notifyChannels: 'desktop' }), bothOn)).toBe('desktop')
    expect(effectiveChannel(task({ notifyChannels: 'wechat' }), bothOn)).toBe('wechat')
    expect(effectiveChannel(task({ notifyChannels: 'both' }), bothOn)).toBe('both')
    expect(effectiveChannel(task({ notifyChannels: 'none' }), bothOn)).toBe('none')
    expect(effectiveChannel(task({ notifyChannels: 'both' }), DEFAULTS)).toBe('desktop')
    expect(effectiveChannel(task({ notifyChannels: 'wechat' }), DEFAULTS)).toBe('none')
  })
})

describe('describeRemaining', () => {
  it('文案与 §5 / §24 的措辞一致', () => {
    expect(describeRemaining(2)).toBe('距离截止还有 2 天')
    expect(describeRemaining(0)).toBe('今天到期')
    expect(describeRemaining(-2)).toBe('已逾期 2 天')
  })
})
