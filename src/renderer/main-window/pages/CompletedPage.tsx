import { toDateKey } from '@shared/date'
import type { Task } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { useTaskList } from '@renderer/shared/hooks/useTaskList'
import { TaskRow } from '../task/TaskRow'

export function CompletedPage(): React.JSX.Element {
  const tasks = useTaskList('completed')
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)

  if (!tasks) {
    return (
      <div className="list">
        <div className="dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    )
  }

  // 按完成日期分组
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = t.completedAt ? toDateKey(new Date(t.completedAt)) : '未知日期'
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }

  return (
    <div className="list">
      {groups.size === 0 && <div className="empty">还没有完成的任务</div>}
      {[...groups.entries()].map(([dateKey, list]) => (
        <div key={dateKey}>
          <div className="list-group-title">
            {dateKey} · {list.length}
          </div>
          {list.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              showDate={false}
              onToggle={() => void toggle(task.id)}
              onEdit={() => openEditor(task)}
              onRemove={() => void remove(task.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
