import { useAppStore } from '@renderer/shared/store/appStore'
import { useTaskList } from '@renderer/shared/hooks/useTaskList'
import type { Task } from '@shared/types'
import { TaskRow } from '../task/TaskRow'

/** 月份组标题：本年显示「9月」，跨年显示「2025年12月」 */
function monthLabel(monthKey: string, now: Date): string {
  const [y, m] = monthKey.split('-').map(Number)
  return y === now.getFullYear() ? `${m}月` : `${y}年${m}月`
}

/**
 * 全部任务。点通知定位过来时落在这里 —— 只有这里保证能查到任意一条任务。
 *
 * 展示按月份分组（用户反馈：平铺一长串没有时间感）：
 * SQL 已按 due_date ASC、无日期殿后排序，这里只需顺序落桶，月份天然有序。
 */
export function AllTasksPage(): React.JSX.Element {
  const tasks = useTaskList('all')
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)
  const locateId = useAppStore((s) => s.locateId)

  const now = new Date()

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

  // 月份分桶。key 为 YYYY-MM；无日期任务归入 ''，排在最后
  const groups = new Map<string, Task[]>()
  for (const t of tasks) {
    const key = t.dueDate ? t.dueDate.slice(0, 7) : ''
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }

  return (
    <div className="list">
      {tasks.length === 0 && <div className="empty">还没有任何任务</div>}
      {[...groups.entries()].map(([monthKey, list]) => (
        <div key={monthKey || 'nodate'}>
          <div className="list-group-title">
            {monthKey ? `${monthLabel(monthKey, now)} · ${list.length}` : `无日期 · ${list.length}`}
          </div>
          {list.map((task) => (
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
      ))}
    </div>
  )
}
