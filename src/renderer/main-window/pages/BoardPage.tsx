import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core'
import type { BoardColumn as ColumnKey, Priority } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { BoardColumn } from '../kanban/BoardColumn'
import { COLUMNS, alreadyInColumn } from '../kanban/columnPresets'

export function BoardPage(): React.JSX.Element {
  const board = useAppStore((s) => s.board)
  const lastCreatedId = useAppStore((s) => s.lastCreatedId)
  const move = useAppStore((s) => s.move)
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const setPriority = useAppStore((s) => s.setPriority)
  const capture = useAppStore((s) => s.capture)
  const openEditor = useAppStore((s) => s.openEditor)

  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 移动超过 5px 才算拖拽，否则勾选框和 ··· 菜单的点击会被吃掉
      activationConstraint: { distance: 5 }
    })
  )

  if (!board) {
    return (
      <div className="board">
        <div className="dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    )
  }

  const { todayKey } = board
  const byColumn: Record<ColumnKey, typeof board.pool> = {
    pool: board.pool,
    todayPending: board.todayPending,
    todayDone: board.todayDone
  }
  const allTasks = [...board.pool, ...board.todayPending, ...board.todayDone]
  const activeTask = allTasks.find((t) => t.id === activeId) ?? null

  const handleDragStart = (e: DragStartEvent): void => setActiveId(String(e.active.id))

  const handleDragEnd = (e: DragEndEvent): void => {
    setActiveId(null)
    const target = e.over?.id as ColumnKey | undefined
    if (!target) return
    const task = allTasks.find((t) => t.id === String(e.active.id))
    if (!task) return
    // 已经在这一列就不写库，省掉一次无意义的提醒重算
    if (alreadyInColumn(task, target, todayKey)) return
    void move(task.id, target)
  }

  /** 列内快速添加复用同一套捕获解析 —— 显式写的日期优先于列语义 */
  const handleQuickAdd = async (title: string, column: ColumnKey): Promise<void> => {
    await capture(title, column === 'pool' ? 'pool' : 'today')
  }

  /** 看板不像列表页那样带着 Task 对象回调 id，这里补一次查表 */
  const handleEdit = (id: string): void => {
    const task = allTasks.find((t) => t.id === id)
    if (task) openEditor(task)
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="board">
        {COLUMNS.map((def) => (
          <BoardColumn
            key={def.key}
            def={def}
            tasks={byColumn[def.key]}
            lastCreatedId={lastCreatedId}
            onToggle={(id) => void toggle(id)}
            onEdit={handleEdit}
            onRemove={(id) => void remove(id)}
            onPriority={(id, p: Priority) => void setPriority(id, p)}
            onQuickAdd={handleQuickAdd}
          />
        ))}
      </div>

      {/* dropAnimation=null：dnd-kit 默认在放下后把浮层「飞回」源卡片位置，
          但我们放下瞬间就写库+刷新，源卡片被重渲染/换列，动画失去测量目标，
          浮层会冻在半路 —— 就是用户看到的「返回动画残留」。干脆不留动画，
          结果由数据刷新 + 新建高亮来表达 */}
      <DragOverlay dropAnimation={null}>
        {activeTask && <div className="drag-overlay">{activeTask.title}</div>}
      </DragOverlay>
    </DndContext>
  )
}
