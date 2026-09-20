import { useEffect, useRef, useState } from 'react'
import { useDraggable } from '@dnd-kit/core'
import { dueLabel } from '@shared/date'
import { describeReminderRule } from '@shared/reminder-plan'
import type { Priority, Task } from '@shared/types'
import { CheckCircle } from '@renderer/shared/components/CheckCircle'
import { TagPill } from '@renderer/shared/components/TagPill'
import { PriorityBadge, PRIORITY_META, PRIORITY_ORDER } from '@renderer/shared/components/PriorityBadge'
import { Icon } from '@renderer/shared/components/Icon'
import { DUE_TONE_COLOR } from '@renderer/shared/components/tone'

export function TaskCard({
  task,
  flash,
  onToggle,
  onEdit,
  onRemove,
  onPriority
}: {
  task: Task
  flash: boolean
  onToggle: () => void
  onEdit: () => void
  onRemove: () => void
  onPriority: (p: Priority) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const done = task.status === 'completed'
  const flag = !done && task.dueDate ? dueLabel(task.dueDate) : null

  return (
    <div
      ref={setNodeRef}
      data-task={task.id}
      className={`card${done ? ' is-completed' : ''}${isDragging ? ' is-dragging' : ''}${flash ? ' card-flash' : ''}`}
      // 双击进编辑器。卡片本身是可拖拽的，所以「编辑」不能是单击 ——
      // 单击要留给拖拽的起手式，用双击才不会打架
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
      {...listeners}
      {...attributes}
    >
      <div className="card-row1">
        <CheckCircle done={done} onToggle={onToggle} />
        <div className="card-title">{task.title}</div>
        {flag && (
          <span className="card-flag" style={{ color: DUE_TONE_COLOR[flag.tone] }}>
            {flag.text}
          </span>
        )}
      </div>

      <div className="card-row2">
        <div className="card-tags">
          {task.tags.map((t) => (
            <TagPill key={t.id} tag={t} />
          ))}
        </div>
        {/* 铃铛只在「真的会提醒」时出现：没有截止日期就没有提醒锚点 */}
        {task.reminderEnabled && task.dueDate && !done && (
          <span className="remind-dot" title={describeReminderRule(task)}>
            <Icon name="bell" size={13} />
          </span>
        )}
        <PriorityBadge priority={task.priority} />
      </div>

      <div ref={menuRef}>
        <button
          type="button"
          className="card-menu"
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          <Icon name="more" />
        </button>

        {menuOpen && (
          <div className="menu" onClick={(e) => e.stopPropagation()}>
            {PRIORITY_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                className="menu-item"
                onClick={() => {
                  onPriority(p)
                  setMenuOpen(false)
                }}
              >
                <span style={{ color: PRIORITY_META[p].color, fontWeight: 500 }}>{PRIORITY_META[p].label}</span>
                <span className="menu-item-sub">
                  {p === 1 ? '紧急' : p === 2 ? '重要' : '普通'}
                  {task.priority === p ? ' · 当前' : ''}
                </span>
              </button>
            ))}
            <div className="menu-divider" />
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                onEdit()
                setMenuOpen(false)
              }}
            >
              <Icon name="edit" size={14} />
              <span className="menu-item-sub">编辑任务</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>双击亦可</span>
            </button>
            <button
              type="button"
              className="menu-item is-danger"
              onClick={() => {
                onRemove()
                setMenuOpen(false)
              }}
            >
              <Icon name="trash" size={14} />
              <span className="menu-item-sub">删除任务</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
