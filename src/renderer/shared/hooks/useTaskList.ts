import { useEffect, useState } from 'react'
import type { ListScope } from '@shared/api'
import type { Task } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'

/**
 * 拉取某个范围的任务列表。
 *
 * 刷新信号是 store 里的 `revision` —— 任何写操作（捕获、勾选、拖拽、删除）都会走
 * refresh()，revision 自增，这里就自动重新拉。不需要每个页面自己订阅 IPC 事件，
 * 也就不会出现「看板更新了但列表页还是旧数据」。
 */
export function useTaskList(scope: ListScope): Task[] | null {
  const revision = useAppStore((s) => s.revision)
  const [tasks, setTasks] = useState<Task[] | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.task
      .list(scope)
      .then((list) => {
        if (alive) setTasks(list)
      })
      .catch(() => {
        if (alive) setTasks([])
      })
    return () => {
      alive = false
    }
  }, [scope, revision])

  return tasks
}
