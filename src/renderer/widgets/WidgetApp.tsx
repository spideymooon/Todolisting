import { useEffect, useMemo, useRef, useState } from 'react'
import { type CaptureTarget } from '@shared/capture-parse'
import { dateKeyLabel, diffDays, todayKey } from '@shared/date'
import type { Task } from '@shared/types'
import { useWidgetStore } from './widgetStore'

/**
 * 桌面小组件：最近待办（《00-架构设计》§14.4）。
 *
 * 内容取舍：只显示「逾期 + 今天 + 明天 + 后天」四组。
 * 再远的事情放在桌面上没有决策价值（挡视线），需要看全量时点一下进主窗口。
 *
 * 三处复用既有约定，避免另起炉灶：
 *  1. 快速添加用 @shared/capture-parse 解析、走同一个 `task:capture` IPC
 *  2. 逾期/今天/明天 的着色沿用 tasks 页同一套 token（--due-overdue / --due-today / --due-soon）
 *  3. 点击任务 → openMain(taskId) → 主进程 openAndLocate → 主窗口定位高亮
 */

interface Group {
  key: 'overdue' | 'today' | 'tomorrow' | 'dayAfter'
  label: string
  tone: 'overdue' | 'today' | 'soon' | 'normal'
  tasks: Task[]
}

/** 默认折叠状态：四组都展开。折叠状态只在本次会话内有效（组件级 state） */
const COLLAPSE_KEY = 'todolet.widget.collapsed'

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
  const pinned = settings.widgetAlwaysOnTop

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

  useEffect(() => {
    if (!justDoneId) return
    const t = window.setTimeout(() => clearJustDone(), 400)
    return () => window.clearTimeout(t)
  }, [justDoneId, clearJustDone])

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]))
  }, [collapsed])

  const groups = useMemo<Group[]>(() => {
    const today = todayKey()
    const buckets: Record<Group['key'], Task[]> = {
      overdue: [],
      today: [],
      tomorrow: [],
      dayAfter: []
    }
    for (const t of tasks) {
      if (t.status === 'completed' || !t.dueDate) continue
      const delta = diffDays(today, t.dueDate)
      if (delta < 0) buckets.overdue.push(t)
      else if (delta === 0) buckets.today.push(t)
      else if (delta === 1) buckets.tomorrow.push(t)
      else if (delta === 2) buckets.dayAfter.push(t)
    }
    // 逾期组内按逾期天数倒序（最久的在最上面），其余按截止时刻
    buckets.overdue.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
    for (const k of ['today', 'tomorrow', 'dayAfter'] as const) {
      buckets[k].sort((a, b) => (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99'))
    }
    const LABEL: Record<Group['key'], string> = {
      overdue: '已逾期',
      today: '今天',
      tomorrow: '明天',
      dayAfter: '后天'
    }
    const TONE: Record<Group['key'], Group['tone']> = {
      overdue: 'overdue',
      today: 'today',
      tomorrow: 'soon',
      dayAfter: 'normal'
    }
    return (['overdue', 'today', 'tomorrow', 'dayAfter'] as const)
      .map((key) => ({ key, label: LABEL[key], tone: TONE[key], tasks: buckets[key] }))
      .filter((g) => g.tasks.length > 0)
  }, [tasks])

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

  return (
    <div
      className="wg"
      style={{ background: `rgba(28, 29, 33, ${(settings.widgetOpacity ?? 86) / 100})` }}
    >
      {/* 拖拽区。透明窗口没有标题栏，必须给一块明确的「把手」，
          同时保证它不覆盖输入框与任务行，否则会吃掉点击 */}
      <div className="wg-head">
        <span className={`wg-dot${total > 0 ? ' is-live' : ''}`} />
        <span className="wg-title">最近待办</span>
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
            最近三天没有待办
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
    </div>
  )
}

/** 逾期任务显示原始日期（「今天/明天」对逾期无意义） */
function shortDate(t: Task, groupKey: Group['key']): string {
  if (groupKey === 'overdue') return t.dueDate ? dateKeyLabel(t.dueDate) : ''
  return ''
}
