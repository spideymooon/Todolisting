import { useEffect, useMemo, useState } from 'react'
import { monthGrid } from '@shared/calendar-grid'
import { fromDateKey, todayKey, weekdayCn } from '@shared/date'
import type { Task } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { useTaskList } from '@renderer/shared/hooks/useTaskList'
import { TaskRow } from '../task/TaskRow'
import { Icon } from '@renderer/shared/components/Icon'

/**
 * 日历页（月历视图）。
 *
 * 原「今天」页改为月历（《TodoList-今天页面改为月历视图》）。几条硬约束的实现落点：
 *
 * - 数据零新增：任务直接来自现有 list('all') 查询（未删除全量，含已完成），
 *   按渲染层已有的 Todo.dueDate 落格 —— 不建 Calendar 专用表、不复制任务
 * - 重复任务：库里只有「当前实例」，它的 dueDate 在哪个月就显示在哪格；
 *   未来实例不存在，也就无从伪造、无从重复显示
 * - 编辑复用：点格内任务直接 openEditor（现有 TaskEditor 弹窗），不做任务详情
 * - 新增复用：右上角「+ 添加任务」走 openCreator(selectedDate)，编辑器新键模式
 *   只多了一个预填日期，创建链路本身没动
 * - 「今天」与「选中日期」是两个状态：今天格永远有圆形日期标记；
 *   选中格有描边；两者重合时叠加显示
 * - 布局铺满：7 列 grid 1fr 均分内容区，窗口变大月历跟着变大，
 *   不像看板列那样固定宽度留白
 */

/**
 * 每格最多显示的任务条数，其余折叠成 +N（显示前 2～3 条，格高统一不被撑开）。
 *
 * 取 2 而不是 3：最小窗口（1080×720）下 6 行月份的格高约 65px，
 * 日期行 20px + 两条任务 36px + 间距恰好放满；放 3 条会溢出被裁。
 * 更多任务点 +N 在下方列表看全部。
 */
const MAX_VISIBLE = 2

/** 表头顺序与网格列序一致：一周从周一开始 */
const WEEKDAY_HEADS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 月份锚点加减，自动跨年（new Date 的月份溢出归一化） */
function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const d = new Date(y, m - 1 + delta, 1)
  return { y: d.getFullYear(), m: d.getMonth() + 1 }
}

/** 同一天内的排序：未完成在前；有时刻的按时刻、无时刻殿后；再按创建先后 */
function sortForDay(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    const doneDelta = (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0)
    if (doneDelta !== 0) return doneDelta
    const timeDelta = (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99')
    if (timeDelta !== 0) return timeDelta
    return a.createdAt.localeCompare(b.createdAt)
  })
}

export function CalendarPage(): React.JSX.Element {
  const tasks = useTaskList('all')
  const calendarSelected = useAppStore((s) => s.calendarSelected)
  const setCalendarSelected = useAppStore((s) => s.setCalendarSelected)
  const openEditor = useAppStore((s) => s.openEditor)
  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)

  const today = todayKey()

  // 首次进入（或 store 里还没有选中日期时）选中今天，下方列表立刻有内容可看。
  // 切页回来时已有选中日期则原样保留，不打扰
  useEffect(() => {
    if (calendarSelected === null) setCalendarSelected(today)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时兜底一次
  }, [])

  // 显示中的月份锚点。初始对齐已选日期（切页回来不失上下文），否则今天所在月
  const [anchor, setAnchor] = useState(() => {
    const base = fromDateKey(calendarSelected ?? today)
    return { y: base.getFullYear(), m: base.getMonth() + 1 }
  })

  const cells = useMemo(() => monthGrid(anchor.y, anchor.m), [anchor])

  /**
   * dueDate → 当天任务。来源是现有查询（list('all')，未删除全量、含已完成），
   * 这里只做渲染层分桶，不新增任何持久化。
   */
  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>()
    if (!tasks) return map
    for (const t of tasks) {
      if (!t.dueDate) continue
      const list = map.get(t.dueDate) ?? []
      list.push(t)
      map.set(t.dueDate, list)
    }
    for (const list of map.values()) sortForDay(list)
    return map
  }, [tasks])

  // 下方列表永远有日期可显示：未选中时跟今天（与「+ 添加任务」的默认逻辑一致）
  const panelKey = calendarSelected ?? today
  const panelTasks = byDate.get(panelKey) ?? []
  const panelDate = fromDateKey(panelKey)
  const panelHead = `${panelDate.getMonth() + 1}月${panelDate.getDate()}日 · 周${weekdayCn(panelKey)}`
  const panelDone = panelTasks.filter((t) => t.status === 'completed').length

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
    <div className="cal">
      {/* 顶部控制：‹ 年月 › + 回到今天 */}
      <div className="cal-toolbar">
        <button
          type="button"
          className="cal-nav-btn"
          title="上个月"
          onClick={() => setAnchor((a) => shiftMonth(a.y, a.m, -1))}
        >
          <Icon name="chevron-left" size={15} strokeWidth={1.6} />
        </button>
        <div className="cal-month-label">{anchor.y}年{anchor.m}月</div>
        <button
          type="button"
          className="cal-nav-btn"
          title="下个月"
          onClick={() => setAnchor((a) => shiftMonth(a.y, a.m, 1))}
        >
          <Icon name="chevron-right" size={15} strokeWidth={1.6} />
        </button>
        <div className="cal-toolbar-spacer" />
        <button
          type="button"
          className="cal-today-btn"
          onClick={() => {
            const base = fromDateKey(today)
            setAnchor({ y: base.getFullYear(), m: base.getMonth() + 1 })
            setCalendarSelected(today)
          }}
        >
          今天
        </button>
      </div>

      {/* 星期表头（周一开头） */}
      <div className="cal-weekdays">
        {WEEKDAY_HEADS.map((w) => (
          <div key={w} className="cal-weekday">
            {w}
          </div>
        ))}
      </div>

      {/* 月网格：7 列随内容区伸缩，行高在保底之上均分剩余高度 */}
      <div className="cal-grid">
        {cells.map((c) => {
          const list = byDate.get(c.key) ?? []
          const visible = list.slice(0, MAX_VISIBLE)
          const hidden = list.length - visible.length
          const isToday = c.key === today
          const isSelected = c.key === calendarSelected
          const cls =
            `cal-cell${c.inMonth ? '' : ' is-outside'}` +
            `${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`
          return (
            <div key={c.key} className={cls} onClick={() => setCalendarSelected(c.key)}>
              {/* 日期数字与 +N 同行：+N 不占任务行位，格高在任何窗口下都够用 */}
              <div className="cal-cell-head">
                <span className="cal-day-num">{c.day}</span>
                {hidden > 0 && (
                  <button
                    type="button"
                    className="cal-more"
                    title={`还有 ${hidden} 个任务，点击查看全部`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCalendarSelected(c.key)
                    }}
                  >
                    +{hidden}
                  </button>
                )}
              </div>

              {visible.map((t) => {
                const done = t.status === 'completed'
                // 逾期 = 还没完成且截止日已过（本地日历日的字符串比较是安全的）
                const overdue = !done && t.dueDate !== null && t.dueDate < today
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`cal-task${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`}
                    title={t.title}
                    onClick={(e) => {
                      // 点任务是打开编辑器，不该顺带改变选中日期
                      e.stopPropagation()
                      openEditor(t)
                    }}
                  >
                    <span className="cal-task-dot" />
                    <span className="cal-task-title">{t.title}</span>
                    {!done && t.reminderEnabled && (
                      <span className="remind-dot">
                        <Icon name="bell" size={11} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      {/* 选中日期的任务列表：轻量一行标题 + 现有 TaskRow，不做大型详情栏 */}
      <div className="cal-day-panel">
        <div className="cal-day-head">
          <span className="cal-day-title">{panelHead}</span>
          <span className="cal-day-count">
            {panelTasks.length} 个任务{panelDone > 0 ? ` · 已完成 ${panelDone}` : ''}
          </span>
        </div>
        <div className="cal-day-list">
          {panelTasks.length === 0 && <div className="empty">这一天还没有任务</div>}
          {panelTasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              showDate={false}
              onToggle={() => void toggle(t.id)}
              onEdit={() => openEditor(t)}
              onRemove={() => void remove(t.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
