import { useAppStore } from '@renderer/shared/store/appStore'
import { useTaskList } from '@renderer/shared/hooks/useTaskList'
import { TaskRow } from '../task/TaskRow'

/** 全部任务。点通知定位过来时落在这里 —— 只有这里保证能查到任意一条任务 */
export function AllTasksPage(): React.JSX.Element {
  const tasks = useTaskList('all')
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)
  const locateId = useAppStore((s) => s.locateId)

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

  return (
    <div className="list">
      {tasks.length === 0 && <div className="empty">还没有任何任务</div>}
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          flash={task.id === locateId}
          onToggle={() => void toggle(task.id)}
          onEdit={() => openEditor(task)}
          onRemove={() => void remove(task.id)}
        />
      ))}
    </div>
  )
}
