import { useAppStore } from '@renderer/shared/store/appStore'
import { TaskRow } from '../task/TaskRow'

/** 今天页：单列 TodoList，与看板「今日待完成」读同一份数据（§5.7） */
export function TodayPage(): React.JSX.Element {
  const board = useAppStore((s) => s.board)
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)

  if (!board) {
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

  const pending = board.todayPending
  const done = board.todayDone

  return (
    <div className="list">
      {pending.length === 0 && <div className="empty">今天还没有任务，在上面输入试试</div>}

      {pending.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          onToggle={() => void toggle(task.id)}
          onEdit={() => openEditor(task)}
          onRemove={() => void remove(task.id)}
        />
      ))}

      {done.length > 0 && (
        <>
          <div className="list-group-title">已完成 · {done.length}</div>
          {done.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => void toggle(task.id)}
              onEdit={() => openEditor(task)}
              onRemove={() => void remove(task.id)}
            />
          ))}
        </>
      )}
    </div>
  )
}
