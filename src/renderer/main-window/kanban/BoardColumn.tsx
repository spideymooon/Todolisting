import { useEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { BoardColumn as ColumnKey, Priority, Task } from '@shared/types'
import { Icon } from '@renderer/shared/components/Icon'
import { TaskCard } from './TaskCard'
import type { ColumnDef } from './columnPresets'

export function BoardColumn({
  def,
  tasks,
  lastCreatedId,
  onToggle,
  onEdit,
  onRemove,
  onPriority,
  onQuickAdd
}: {
  def: ColumnDef
  tasks: Task[]
  lastCreatedId: string | null
  onToggle: (id: string) => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
  onPriority: (id: string, p: Priority) => void
  onQuickAdd: (title: string, column: ColumnKey) => Promise<void>
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: def.key })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commit = async (): Promise<void> => {
    const value = draft.trim()
    if (value) await onQuickAdd(value, def.key)
    setDraft('')
    // 保持输入态，支持连续录入
    inputRef.current?.focus()
  }

  return (
    <section ref={setNodeRef} className={`column${isOver ? ' is-over' : ''}`}>
      <div className="column-head">
        <span className="column-title">{def.title}</span>
        <span className="column-count">{tasks.length}</span>
      </div>

      <div className="column-body">
        {tasks.length === 0 && !editing && <div className="column-empty">{def.empty}</div>}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            flash={task.id === lastCreatedId}
            onToggle={() => onToggle(task.id)}
            onEdit={() => onEdit(task.id)}
            onRemove={() => onRemove(task.id)}
            onPriority={(p) => onPriority(task.id, p)}
          />
        ))}
      </div>

      {def.addLabel &&
        (editing ? (
          <div className="column-add is-editing">
            <input
              ref={inputRef}
              value={draft}
              spellCheck={false}
              placeholder={def.addLabel}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commit()
                }
                if (e.key === 'Escape') {
                  setDraft('')
                  setEditing(false)
                }
              }}
              onBlur={() => {
                if (!draft.trim()) setEditing(false)
              }}
            />
          </div>
        ) : (
          <button type="button" className="column-add" onClick={() => setEditing(true)}>
            <Icon name="plus" size={13} strokeWidth={1.6} />
            {def.addLabel}
          </button>
        ))}
    </section>
  )
}
