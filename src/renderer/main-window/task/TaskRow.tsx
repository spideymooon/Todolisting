import { useEffect, useRef } from 'react'
import { dueLabel } from '@shared/date'
import { describeReminderRule } from '@shared/reminder-plan'
import type { Task } from '@shared/types'
import { CheckCircle } from '@renderer/shared/components/CheckCircle'
import { TagPill } from '@renderer/shared/components/TagPill'
import { Icon } from '@renderer/shared/components/Icon'
import { DUE_TONE_COLOR } from '@renderer/shared/components/tone'

/**
 * 单列列表页（今天 / 即将到期 / 全部 / 已完成）共用的一行。
 *
 * §16 要求「悬停显示操作 + 快捷操作」。这里两者都做：
 *   - 悬停：编辑 / 删除（完成用左侧圆圈，不重复放按钮）
 *   - 键盘：行获得焦点后 Space 完成、Enter 编辑、Delete 删除
 *
 * 行的 tabIndex=0 是必要的：不聚焦就没有键盘事件。代价是 Tab 会依次走过所有任务，
 * 但这正好是「键盘用户逐条处理任务」想要的行为。
 */
export function TaskRow({
  task,
  showDate = true,
  flash = false,
  onToggle,
  onEdit,
  onRemove
}: {
  task: Task
  showDate?: boolean
  /** 从通知点进来时闪一下，告诉用户「就是这一条」 */
  flash?: boolean
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  const done = task.status === 'completed'
  const flag = showDate && task.dueDate ? dueLabel(task.dueDate) : null
  const rowRef = useRef<HTMLDivElement>(null)

  // 定位过来时滚进视野。block:'center' 比默认的 'start' 更好找
  useEffect(() => {
    if (flash) rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [flash])

  return (
    <div
      ref={rowRef}
      className={`row${done ? ' is-completed' : ''}${flash ? ' row-flash' : ''}`}
      data-task={task.id}
      tabIndex={0}
      onKeyDown={(e) => {
        // 在输入框里敲空格不该完成任务
        if (e.target !== e.currentTarget) return
        if (e.key === ' ') {
          e.preventDefault()
          onToggle()
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onEdit()
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          onRemove()
        }
      }}
    >
      <CheckCircle done={done} onToggle={onToggle} />
      <span className="row-title" title={task.title}>
        {task.title}
      </span>

      <span className="row-meta">
        {task.tags.slice(0, 2).map((t) => (
          <TagPill key={t.id} tag={t} />
        ))}
        {task.reminderEnabled && task.dueDate && !done && (
          <span className="remind-dot" title={describeReminderRule(task)}>
            <Icon name="bell" size={13} />
          </span>
        )}
        {flag && <span style={{ color: DUE_TONE_COLOR[flag.tone] }}>{flag.text}</span>}
      </span>

      <span className="row-actions">
        <button type="button" className="icon-btn" title="编辑任务 (Enter)" onClick={onEdit}>
          <Icon name="edit" size={14} />
        </button>
        <button type="button" className="icon-btn is-danger" title="删除任务 (Delete)" onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </span>
    </div>
  )
}
