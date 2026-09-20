/**
 * 通知文案（纯函数）。
 *
 * 桌面通知与 PushPlus 共用同一份措辞来源 —— 否则两个通道的文案会各自漂移，
 * 用户看到的同一条提醒「说」得不一样。
 */

import { describeRemaining, type ReminderPlan } from '@shared/reminder-plan'
import type { Task } from '@shared/types'

/**
 * 发送时刻只需要这三个字段 —— 故意不收完整的 ReminderPlan，
 * 因为发送时不需要（也不该）重新推导提醒时刻：计划早已定好，改的是天数的表述。
 */
export type MessagePlan = Pick<ReminderPlan, 'type' | 'daysLeft' | 'planKey'>

export interface NotifyMessage {
  taskId: string
  planKey: string
  title: string
  /** 桌面 toast 的正文（§5 模板，两行） */
  body: string
  /** PushPlus 用的更长正文，含截止时刻 */
  detail: string
}

/** §5 通知模板：标题 `📌 任务即将到期` + 正文 `「提交周报」\n距离截止还有 2 天` */
export function buildMessage(task: Task, plan: MessagePlan): NotifyMessage {
  const isOverdue = plan.type === 'overdue'
  const title = isOverdue ? '📌 任务已逾期' : '📌 任务即将到期'
  const remaining = describeRemaining(plan.daysLeft)
  const deadline = task.dueDate
    ? `${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ''}`
    : '未设定'

  const body = isOverdue
    ? `「${task.title}」\n${remaining}，请尽快处理`
    : `「${task.title}」\n${remaining}`

  const detail = [
    `**${isOverdue ? '任务已逾期' : '任务即将到期'}**`,
    '',
    `「${task.title}」`,
    remaining,
    `截止：${deadline}`,
    task.note ? `\n备注：${task.note}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return { taskId: task.id, planKey: plan.planKey, title, body, detail }
}
