/**
 * 首次创建数据库时写入的示例数据。
 *
 * 只在「数据库文件本来不存在」时执行一次，不覆盖任何已有数据。
 * 目的有两个：让第一版打开就能看到三列看板的真实形态；以及**首次启动就能看到
 * 提醒系统两条不同的路径**（正常排期 / 立即补发 / 逾期补提醒 / 刻意不提醒）。
 */

import type { TaskService } from './core/task/task.service'
import { offsetKey } from '@shared/date'

interface Sample {
  title: string
  /** 相对今天的天数；null = 无日期（落待办池） */
  offset: number | null
  tags: string[]
  priority: 1 | 2 | 3
  time?: string
  done?: boolean
  /** 提前天数。不写则用全局默认（1 天） */
  reminderDays?: number
  /** 明确关掉提醒的任务，用来演示「不会被通知打扰」 */
  reminderEnabled?: boolean
}

const SAMPLES: Sample[] = [
  // 今天 18:00 截止 + 提前 1 天 → 提醒时刻（昨天 09:00）已过但还没到截止
  // → 立刻补发一次。这是需求评审里点出的最高频场景：临期才记下来
  { title: '交周报', offset: 0, tags: ['工作'], priority: 1, time: '18:00', reminderDays: 1, done: false },
  // 今天截止但没写具体时刻 → 刻意不补发，避免「记一条弹一个通知」
  { title: '交9月房租', offset: 0, tags: ['生活'], priority: 2 },
  // 明确关掉提醒
  { title: '整理会议记录', offset: 0, tags: ['工作'], priority: 3, reminderEnabled: false },
  { title: '背英语单词', offset: 0, tags: ['学习'], priority: 3, done: true },
  { title: '买咖啡豆', offset: null, tags: ['生活'], priority: 3 },
  { title: '读《设计心理学》第 3 章', offset: null, tags: ['学习'], priority: 3 },
  // 后天截止 + 提前 1 天 → 明天 09:00 正常排期，能在设置页的提醒日志里看到
  { title: '预约体检', offset: 2, tags: ['健康'], priority: 2, reminderDays: 1 },
  // 已逾期 → 按「补一次」策略立即补提醒（用来验证 §24 逾期状态）
  { title: '把上季度报销单交上去', offset: -2, tags: ['工作'], priority: 1, reminderDays: 1 }
]

export function seedSampleData(service: TaskService, now: Date = new Date()): number {
  let created = 0
  for (const s of SAMPLES) {
    const task = service.create(
      {
        title: s.title,
        priority: s.priority,
        dueDate: s.offset === null ? null : offsetKey(now, s.offset),
        dueTime: s.time ?? null,
        tags: s.tags,
        reminderDays: s.reminderDays,
        reminderEnabled: s.reminderEnabled
      },
      now
    )
    if (s.done) service.toggle(task.id, now)
    created++
  }
  return created
}
