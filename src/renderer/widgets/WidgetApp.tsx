import { useEffect, useMemo, useRef, useState } from 'react'
import { type CaptureTarget } from '@shared/capture-parse'
import { dateKeyLabel, diffDays, todayKey } from '@shared/date'
import type { Task, WidgetScope } from '@shared/types'
import { useWidgetStore, widgetScopeOf, WIDGET_SCOPE_OPTIONS } from './widgetStore'

/**
 * 桌面小组件：桌面待办便签（《00-架构设计》§14.4）。
 *
 * 内容取舍跟随设置里的 widgetScope（主窗口「小组件」页可改），默认 all =
 * 所有未完成任务。分组渲染是通用的：按相对今天的日期差落桶，
 * 不在当前 scope 取数范围内的桶自然为空、不渲染。
 *
 * 三处复用既有约定，避免另起炉灶：
 *  1. 快速添加用 @shared/capture-parse 解析、走同一个 `task:capture` IPC
 *  2. 逾期/今天/明天 的着色沿用 tasks 页同一套 token（--due-overdue / --due-today / --due-soon）
 *  3. 点击任务 → openMain(taskId) → 主进程 openAndLocate → 主窗口定位高亮
 */

interface Group {
  key: 'overdue' | 'today' | 'tomorrow' | 'dayAfter' | 'later' | 'nodate' | 'completed'
  label: string
  tone: 'overdue' | 'today' | 'soon' | 'normal'
  tasks: Task[]
}

/** 各显示范围下的标题与空态文案 */
const SCOPE_TEXT: Record<WidgetScope, { title: string; empty: string }> = {
  today: { title: '今天待办', empty: '今天没有待办' },
  upcoming: { title: '待办任务', empty: '没有未来的待办' },
  window: { title: '最近待办', empty: '最近三天没有待办' },
  all: { title: '全部待办', empty: '没有待办任务' },
  completed: { title: '已完成', empty: '还没有已完成的任务' }
}

/** 默认折叠状态：所有组都展开。折叠状态只在本次会话内有效（组件级 state） */
const COLLAPSE_KEY = 'todolet.widget.collapsed'

/**
 * 缩放下限的渲染层镜像。主进程也有一份（setMinimumSize），两处都要有：
 * 渲染层这份是为了让鼠标拖拽时**当场**就停在边界上，不然会是「拖过头 → 系统钳回」
 * 那种一顿一顿的手感。
 */
const MIN_W = 240
const MIN_H = 280

export function WidgetApp(): React.JSX.Element {
  const tasks = useWidgetStore((s) => s.tasks)
  const ready = useWidgetStore((s) => s.ready)
  const justDoneId = useWidgetStore((s) => s.justDoneId)
  const settings = useWidgetStore((s) => s.settings)
  const load = useWidgetStore((s) => s.load)
  const refresh = useWidgetStore((s) => s.refresh)
  const toggle = useWidgetStore((s) => s.toggle)
  const capture = useWidgetStore((s) => s.capture)
  const setPinned = useWidgetStore((s) => s.setPinned)
  const hide = useWidgetStore((s) => s.hide)
  const openMain = useWidgetStore((s) => s.openMain)
  const clearJustDone = useWidgetStore((s) => s.clearJustDone)
  const setScope = useWidgetStore((s) => s.setScope)
  const resizable = useWidgetStore((s) => s.resizable)
  const resizing = useWidgetStore((s) => s.resizing)
  const resizeLockedBy = useWidgetStore((s) => s.resizeLockedBy)
  const setResizing = useWidgetStore((s) => s.setResizing)
  const commitSize = useWidgetStore((s) => s.commitSize)
  const pinned = settings.widgetAlwaysOnTop

  const [menuOpen, setMenuOpen] = useState(false)
  /** 置顶而缩放被锁时，给一次性的文字提示（见下方 showLockHint） */
  const [lockHint, setLockHint] = useState(false)
  const lockHintTimer = useRef<number | null>(null)

  const showLockHint = (): void => {
    setLockHint(true)
    if (lockHintTimer.current !== null) window.clearTimeout(lockHintTimer.current)
    lockHintTimer.current = window.setTimeout(() => setLockHint(false), 2600)
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY)
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  const [text, setText] = useState('')
  const [flash, setFlash] = useState<'idle' | 'ok' | 'err'>('idle')
  const inputRef = useRef<HTMLInputElement>(null)
  const flashTimer = useRef<number | null>(null)

  useEffect(() => {
    void load()
    const off = window.api.on.tasksChanged(() => void refresh())
    // 焦点收敛：即使某次 tasks:changed 广播丢失，用户一点小组件也会强制重取
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [load, refresh])

  // 主进程推送缩放可用性：置顶 → 锁定，取消置顶 → 解锁。
  // 托盘菜单、设置页开关也能改置顶，所以这条广播是唯一可靠的来源
  useEffect(() => {
    return window.api.on.widgetResizeState((state) => {
      useWidgetStore.setState({ resizable: state.resizable, resizeLockedBy: state.lockedBy })
    })
  }, [])

  /**
   * 右下角缩放手柄的拖拽逻辑。
   *
   * 为什么自绘而不用 Window 的原生缩放边框：小组件是 `frame: false` + `transparent`
   * 的窗口，Windows 上根本不会画出可拖的缩放边框（`thickFrame: false` 已经关掉）。
   * 所以必须自己在右下角放一块热点，按住时按鼠标位移改窗口大小。
   *
   * ⚠ 三个平台细节，缺一个都会有 bug：
   *  1. 必须临时把 `-webkit-app-region` 从 drag 改成 no-drag（store 里的 resizing 标志）。
   *     否则鼠标一进入头部拖拽区，整个窗口就变成「被系统拖着走」，`pointermove` 还会
   *     被 Chromium 吞掉 —— 表现就是「拖动时窗口乱跳，尺寸不变」。
   *  2. 用 `setPointerCapture`：不捕获的话鼠标滑出 8×8 的手柄就收不到事件，
   *     拖到一半会「断手」
   *  3. 用 `window.resizeTo` 而不是自己 `setBounds`：resizeTo 走的是窗口系统的
   *     标准路径，DPI 缩放、最小尺寸钳制、多屏边界都由系统处理
   */
  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!resizable) {
      showLockHint()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const startX = e.screenX
    const startY = e.screenY
    const startW = window.innerWidth
    const startH = window.innerHeight
    // setPointerCapture 在合成指针（自动化测试/触摸边缘场景）上会抛 NotFoundError，
    // 真实鼠标不会 —— 但一旦抛错，后面的监听就挂不上了。包一层，失败就退化为
    // 「只在手柄上拖」，功能仍然可用
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // 忽略，见上
    }
    setResizing(true)

    const onMove = (ev: PointerEvent): void => {
      const w = Math.max(MIN_W, startW + (ev.screenX - startX))
      const h = Math.max(MIN_H, startH + (ev.screenY - startY))
      window.resizeTo(w, h)
    }
    const onUp = (): void => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      void commitSize()
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  useEffect(() => {
    if (!justDoneId) return
    const t = window.setTimeout(() => clearJustDone(), 400)
    return () => window.clearTimeout(t)
  }, [justDoneId, clearJustDone])

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]))
  }, [collapsed])

  const groups = useMemo<Group[]>(() => {
    const scope = widgetScopeOf(settings)

    // 已完成视图：SQL 侧已按 completed_at 倒序排好，直接一组平铺
    if (scope === 'completed') {
      return [
        {
          key: 'completed',
          label: '已完成',
          tone: 'normal',
          tasks: tasks.filter((t) => t.status === 'completed')
        }
      ]
    }

    const today = todayKey()
    const buckets: Record<Exclude<Group['key'], 'completed'>, Task[]> = {
      overdue: [],
      today: [],
      tomorrow: [],
      dayAfter: [],
      later: [],
      nodate: []
    }
    for (const t of tasks) {
      if (t.status === 'completed') continue
      if (!t.dueDate) {
        // 无日期任务只在「全部任务」范围出现（其他 scope 的 SQL 都要求 due_date）
        buckets.nodate.push(t)
        continue
      }
      const delta = diffDays(today, t.dueDate)
      if (delta < 0) buckets.overdue.push(t)
      else if (delta === 0) buckets.today.push(t)
      else if (delta === 1) buckets.tomorrow.push(t)
      else if (delta === 2) buckets.dayAfter.push(t)
      else buckets.later.push(t)
    }
    // 逾期组内按逾期天数倒序（最久的在最上面），其余按截止时刻/日期
    buckets.overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    for (const k of ['today', 'tomorrow', 'dayAfter'] as const) {
      buckets[k].sort((a, b) => (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99'))
    }
    buckets.later.sort(
      (a, b) =>
        (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
        (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99')
    )
    const LABEL: Record<Group['key'], string> = {
      overdue: '已逾期',
      today: '今天',
      tomorrow: '明天',
      dayAfter: '后天',
      later: '以后',
      nodate: '无日期',
      completed: '已完成'
    }
    const TONE: Record<Group['key'], Group['tone']> = {
      overdue: 'overdue',
      today: 'today',
      tomorrow: 'soon',
      dayAfter: 'normal',
      later: 'normal',
      nodate: 'normal',
      completed: 'normal'
    }
    return (['overdue', 'today', 'tomorrow', 'dayAfter', 'later', 'nodate'] as const)
      .map((key) => ({ key, label: LABEL[key], tone: TONE[key], tasks: buckets[key] }))
      .filter((g) => g.tasks.length > 0)
  }, [tasks, settings])

  const total = groups.reduce((n, g) => n + g.tasks.length, 0)

  const flashOnce = (kind: 'ok' | 'err'): void => {
    setFlash(kind)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash('idle'), kind === 'err' ? 2200 : 700)
  }

  const submit = async (): Promise<void> => {
    const raw = text.trim()
    if (!raw) return
    const ok = await capture(raw, settings.captureDefaultTarget as CaptureTarget)
    if (ok) {
      setText('')
      flashOnce('ok')
    } else {
      flashOnce('err')
    }
    inputRef.current?.focus()
  }

  const toggleGroup = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const scope = widgetScopeOf(settings)
  const scopeText = SCOPE_TEXT[scope]

  /** 左上角菜单选中某个页面：切换 scope 并收起菜单 */
  const pickScope = (next: WidgetScope): void => {
    setMenuOpen(false)
    if (next !== scope) void setScope(next)
  }

  return (
    <div
      className={`wg${pinned ? ' is-pinned' : ''}${resizing ? ' is-resizing' : ''}`}
      style={{ background: `rgba(28, 29, 33, ${(settings.widgetOpacity ?? 86) / 100})` }}
    >
      {/* 拖拽区。透明窗口没有标题栏，必须给一块明确的「把手」，
          同时保证它不覆盖输入框与任务行，否则会吃掉点击 */}
      <div className="wg-head">
        <span className={`wg-dot${total > 0 ? ' is-live' : ''}`} />
        {/* 左上角 = 页面切换器：点标题弹出菜单选显示哪个页面的任务 */}
        <div className="wg-scope">
          <button
            type="button"
            className={`wg-title-btn${menuOpen ? ' is-open' : ''}`}
            title="点击切换显示的页面"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <span className="wg-title">{scopeText.title}</span>
            <span className="wg-title-caret">
              <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M2 3.5 5 6.5 8 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          {menuOpen && (
            <>
              {/* 透明遮罩：点菜单外面任意处收起 */}
              <div className="wg-menu-overlay" onClick={() => setMenuOpen(false)} />
              <div className="wg-scope-menu" role="menu">
                {WIDGET_SCOPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitem"
                    className={`wg-scope-item${opt.value === scope ? ' is-active' : ''}`}
                    onClick={() => pickScope(opt.value)}
                  >
                    <span>{opt.label}</span>
                    {opt.value === scope && (
                      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                        <path
                          d="M2 6.4 4.6 9 10 3.2"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <span className="wg-count">{total > 0 ? total : ''}</span>
        <button
          type="button"
          className={`wg-icon-btn${pinned ? ' is-active' : ''}`}
          title={pinned ? '取消置顶' : '置顶显示'}
          onClick={() => void setPinned(!pinned)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"
              fill={pinned ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="wg-icon-btn"
          title="打开主窗口"
          onClick={() => void openMain()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4.5 2H2.5A1.5 1.5 0 0 0 1 3.5v6A1.5 1.5 0 0 0 2.5 11h6A1.5 1.5 0 0 0 10 9.5V7.5M7 1h4v4M11 1 5.5 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="wg-icon-btn"
          title="关闭小组件（可在主窗口左侧「小组件」页重新打开）"
          onClick={() => void hide()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M3 3l6 6M9 3l-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="wg-add">
        <input
          ref={inputRef}
          className={`wg-input${flash === 'err' ? ' is-err' : ''}`}
          value={text}
          spellCheck={false}
          placeholder="记点什么，回车存到今天…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape') {
              setText('')
              e.currentTarget.blur()
            }
          }}
        />
        {flash === 'ok' && <span className="wg-flash">✓</span>}
        {flash === 'err' && <span className="wg-flash is-err">失败</span>}
      </div>

      <div className="wg-list">
        {!ready && <div className="wg-empty">加载中…</div>}

        {ready && total === 0 && (
          <div className="wg-empty">
            {scopeText.empty}
            <br />
            <span className="wg-empty-sub">在上面输入框记一条试试</span>
          </div>
        )}

        {groups.map((g) => {
          const isCollapsed = collapsed.has(g.key)
          const done = g.tasks.filter((t) => t.id === justDoneId).length > 0
          return (
            <div key={g.key} className="wg-group">
              <button
                type="button"
                className={`wg-group-head tone-${g.tone}`}
                onClick={() => toggleGroup(g.key)}
              >
                <span className={`wg-caret${isCollapsed ? ' is-collapsed' : ''}`}>
                  <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="M2 3.5 5 6.5 8 3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="wg-group-label">{g.label}</span>
                <span className="wg-group-count">{g.tasks.length}</span>
              </button>

              {!isCollapsed && (
                <div className="wg-group-body">
                  {g.tasks.map((t) => (
                    <div
                      key={t.id}
                      className={`wg-task${t.id === justDoneId ? ' is-done' : ''}${
                        done ? ' is-leaving' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="wg-check"
                        title="标记完成"
                        onClick={(e) => {
                          e.stopPropagation()
                          void toggle(t.id)
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                          <path
                            d="M2 6.4 4.6 9 10 3.2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>

                      <button
                        type="button"
                        className="wg-task-title"
                        title={`${t.title}${t.note ? `\n${t.note}` : ''}\n点击打开主窗口`}
                        onClick={() => void openMain(t.id)}
                      >
                        {t.title}
                      </button>

                      <span className="wg-task-meta">
                        {t.dueTime ?? shortDate(t, g.key)}
                        {t.reminderEnabled && t.dueDate && (
                          <span className="wg-bell" title="已设置提醒">
                            <svg width="9" height="9" viewBox="0 0 14 14" aria-hidden="true">
                              <path
                                d="M7 1.5a3.2 3.2 0 0 0-3.2 3.2c0 2.6-.9 3.4-.9 3.4h8.2s-.9-.8-.9-3.4A3.2 3.2 0 0 0 7 1.5ZM5.8 10.6a1.3 1.3 0 0 0 2.4 0"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.1"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {settings.widgetAlwaysOnTop && (
        <div className="wg-foot">
          点击任务打开主窗口 · 输入框回车即记录
        </div>
      )}

      {/* 右下角缩放手柄。禁用态（置顶锁定）仍然渲染 —— 只是变成「点一下给提示」，
          直接隐藏的话用户只会以为这版没有缩放功能 */}
      <div
        className={`wg-resize${resizable ? '' : ' is-locked'}`}
        role="separator"
        aria-label={resizable ? '拖动调整小组件大小' : '已置顶，缩放被锁定'}
        title={resizable ? '拖动调整大小' : '已置顶，缩放已锁定'}
        onPointerDown={onHandleDown}
      >
        {!resizable && (
          <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M4 8V4.6a1.3 1.3 0 0 1 2.6 0V8M4 5.6h2.6M4 8h2.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect
              x="2.4"
              y="7.2"
              width="5.8"
              height="4"
              rx="1.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      </div>

      {lockHint && (
        <div className="wg-lock-hint">
          {resizeLockedBy === 'alwaysOnTop' ? '已置顶，缩放已锁定 · 取消置顶后可用' : '当前不可缩放'}
        </div>
      )}
    </div>
  )
}

/** 逾期 / 更远期任务显示原始日期（「今天/明天」对它们没有定位价值） */
function shortDate(t: Task, groupKey: Group['key']): string {
  if (groupKey === 'overdue' || groupKey === 'later') return t.dueDate ? dateKeyLabel(t.dueDate) : ''
  return ''
}
