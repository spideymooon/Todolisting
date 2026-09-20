import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/shared/store/appStore'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { Header } from './Header'
import { CaptureBar } from './CaptureBar'
import { BoardPage } from './pages/BoardPage'
import { TodayPage } from './pages/TodayPage'
import { UpcomingPage } from './pages/UpcomingPage'
import { AllTasksPage } from './pages/AllTasksPage'
import { CompletedPage } from './pages/CompletedPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'
import { WidgetPage } from './pages/WidgetPage'
import { TaskEditor } from './task/TaskEditor'

export function App(): React.JSX.Element {
  const page = useAppStore((s) => s.page)
  const ready = useAppStore((s) => s.ready)
  const error = useAppStore((s) => s.error)
  const refresh = useAppStore((s) => s.refresh)
  const requestCaptureFocus = useAppStore((s) => s.requestCaptureFocus)
  const clearFlash = useAppStore((s) => s.clearFlash)
  const lastCreatedId = useAppStore((s) => s.lastCreatedId)
  const editing = useAppStore((s) => s.editing)
  const creating = useAppStore((s) => s.creating)
  const closeEditor = useAppStore((s) => s.closeEditor)
  const locate = useAppStore((s) => s.locate)
  const clearLocate = useAppStore((s) => s.clearLocate)
  const locateId = useAppStore((s) => s.locateId)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)

  // 只有窗口真正有焦点时才自动把光标放进捕获条，
  // 否则用户在别的应用里打字，我们的聚焦会白抢一次焦点
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus())
  const bootstrapped = useRef(false)

  useEffect(() => {
    const onFocus = (): void => {
      setWindowFocused(true)
      // 焦点收敛防线：小组件/其他窗口改了数据，即便 tasks:changed 广播有丢失，
      // 用户一切到主窗口也强制重取一次（两条小查询，代价可忽略）
      void refresh()
    }
    const onBlur = (): void => setWindowFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [refresh])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    void (async () => {
      // 深链：/?page=today 之类。托盘入口与自动化截图用它定位页面
      const params = new URLSearchParams(window.location.search)
      const requested = params.get('page')
      const settings = await window.api.settings.get()
      const valid = ['today', 'board', 'upcoming', 'all', 'completed', 'search', 'widget', 'settings']
      useAppStore.setState({
        settings,
        page: requested && (valid as string[]).includes(requested) ? (requested as never) : 'board'
      })
      await refresh()

      // 深链：/?edit=first 自动打开第一条任务的编辑器；/?edit=new 打开「新建任务」。
      // 弹层类界面没法只靠一张静态截图验证，所以留这个入口给自动化验图与托盘菜单
      if (params.get('edit')) {
        if (params.get('edit') === 'new') {
          useAppStore.getState().openCreator()
        } else {
          const board = useAppStore.getState().board
          const first = board
            ? [...board.todayPending, ...board.pool, ...board.todayDone][0]
            : undefined
          if (first) useAppStore.getState().openEditor(first)
        }
      }
    })()

    const off1 = window.api.on.tasksChanged(() => {
      void refresh()
    })
    // 主进程在窗口获得焦点时发来信号；渲染层自己决定要不要真的聚焦
    const off2 = window.api.on.captureFocus(() => {
      setWindowFocused(true)
      const state = useAppStore.getState()
      // 编辑器打开时不抢焦点 —— 否则光标会从编辑器输入框跳到捕获条
      if (state.page !== 'settings' && !state.editing && !state.creating) requestCaptureFocus()
    })
    // 点击 Windows 通知 → 主进程发来 taskId（§5）
    const off3 = window.api.on.locateTask((taskId) => {
      locate(taskId)
    })
    return () => {
      off1()
      off2()
      off3()
    }
  }, [refresh, requestCaptureFocus, locate])

  // 新建的任务高亮 800ms 后恢复
  useEffect(() => {
    if (!lastCreatedId) return
    const timer = window.setTimeout(() => clearFlash(), 900)
    return () => window.clearTimeout(timer)
  }, [lastCreatedId, clearFlash])

  // 定位高亮 2.2 秒后清掉，避免下次切回「全部任务」时又闪一遍
  useEffect(() => {
    if (!locateId) return
    const timer = window.setTimeout(() => clearLocate(), 2200)
    return () => window.clearTimeout(timer)
  }, [locateId, clearLocate])

  // ↑ 键在空输入时跳到第一条任务
  const focusFirstTask = (): void => {
    const el = document.querySelector<HTMLElement>('[data-task]')
    if (!el) return
    el.focus()
    el.scrollIntoView({ block: 'nearest' })
  }

  // 小组件设置页、设置页、搜索页是纯配置/输入界面，不放快速记录条（搜索页有自己的输入框）
  const captureVisible =
    page !== 'settings' && page !== 'widget' && page !== 'search' && !editing && !creating
  const autoFocus = captureVisible && windowFocused

  if (!ready) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="app">
          <Sidebar />
          <div className="main">
            <div className="list">
              <div className="dots">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="app">
        <Sidebar collapsed={!sidebarOpen} />
        <div className="main">
          <Header />

          {captureVisible && (
            <CaptureBar autoFocus={autoFocus} page={page} onRequestFirstTask={focusFirstTask} />
          )}

          {error && (
            // 复用 capture-hint 的排版，但错误必须始终可见（该类默认是「聚焦才淡入」的静默态）
            <div
              className="capture-hint is-visible"
              style={{ color: 'var(--due-overdue)', opacity: 1 }}
            >
              {error}
            </div>
          )}

          <div className="page-body">
            {page === 'today' && <TodayPage />}
            {page === 'board' && <BoardPage />}
            {page === 'upcoming' && <UpcomingPage />}
            {page === 'all' && <AllTasksPage />}
            {page === 'completed' && <CompletedPage />}
            {page === 'search' && <SearchPage />}
            {page === 'widget' && <WidgetPage />}
            {page === 'settings' && <SettingsPage />}
          </div>
        </div>
      </div>

      {(editing || creating) && <TaskEditor task={editing} onClose={closeEditor} />}
    </div>
  )
}
