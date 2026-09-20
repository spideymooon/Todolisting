import { dueLabel, shortDueLabel, todayKey } from '@shared/date'
import type { Task } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { useTaskList } from '@renderer/shared/hooks/useTaskList'
import { TaskRow } from '../task/TaskRow'

function Loading(): React.JSX.Element {
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

export function UpcomingPage(): React.JSX.Element {
  const tasks = useTaskList('upcoming')
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)

  if (!tasks) return <Loading />

  const today = todayKey()
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    if (!t.dueDate) continue
    const list = groups.get(t.dueDate) ?? []
    list.push(t)
    groups.set(t.dueDate, list)
  }

  return (
    <div className="list">
      {groups.size === 0 && (
        <div className="empty">未来没有安排。想提前记点什么，直接在上面输入「明天 开会」试试</div>
      )}
      {[...groups.entries()].map(([dateKey, list]) => {
        const label = dueLabel(dateKey, new Date(today)).text
        const short = shortDueLabel(dateKey, new Date(today))
        return (
          <div key={dateKey}>
            <div className="list-group-title">
              {label} · {short} · {list.length}
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
        )
      })}
    </div>
  )
}
