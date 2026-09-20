import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/shared/store/appStore'

/**
 * 无边框窗口的自绘标题栏（《UI优化》§8–§10）。
 *
 * 设计原则：**克制**。左侧三枚工具按钮（侧栏收放 / 搜索 / 桌面小组件开关），
 * 中间整条拖拽区，右侧三枚窗口按钮。不显示应用名（品牌在 Sidebar 顶部）。
 *
 * 几处平台细节：
 *  1. `-webkit-app-region: drag` 会被 Electron 映射成 Windows 的 HTCAPTION，
 *     所以双击最大化/还原、Aero Snap 拖到屏幕边缘、系统缩放边框全部由系统提供，
 *     不需要自己算鼠标坐标（也就天然适配 DPI 缩放）。
 *  2. 按钮必须 `no-drag`，否则点击会被拖拽区吞掉。
 *  3. 最大化状态只有主进程知道（双击、Win+↑ 都会改变它），所以订阅 window:state 同步图标。
 */
export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const setPage = useAppStore((s) => s.setPage)
  const page = useAppStore((s) => s.page)
  const widgetEnabled = useAppStore((s) => s.settings.widgetEnabled)
  const updateSettings = useAppStore((s) => s.updateSettings)

  useEffect(() => {
    return window.api.on.windowState((state) => setMaximized(state.maximized))
  }, [])

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <button
          type="button"
          className="titlebar-btn"
          title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          onClick={toggleSidebar}
        >
          <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
            <rect
              x="1.2"
              y="1.8"
              width="9.6"
              height="8.4"
              rx="1.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <path d="M4.6 1.8v8.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>

        <button
          type="button"
          className="titlebar-btn"
          title="搜索"
          onClick={() => setPage(page === 'search' ? 'board' : 'search')}
        >
          <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
            <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <path
              d="M7.4 7.4l3.2 3.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          className="titlebar-btn"
          title={widgetEnabled ? '关闭桌面小组件' : '在桌面显示小组件'}
          onClick={() => void updateSettings({ widgetEnabled: !widgetEnabled })}
        >
          <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
            <rect
              x="1.2"
              y="1.8"
              width="9.6"
              height="8.4"
              rx="1.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
            <rect x="6" y="6" width="3.4" height="3" rx="0.8" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="titlebar-drag" />
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          onClick={() => void window.api.win.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>

        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? '向下还原' : '最大化'}
          onClick={() => {
            void window.api.win.toggleMaximize().then((s) => setMaximized(s.maximized))
          }}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.6 2.6V1h6.4v6.4H7.4M1 3.6h5.4V9H1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="1.2"
                y="1.2"
                width="7.6"
                height="7.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="titlebar-btn is-close"
          title="关闭"
          onClick={() => void window.api.win.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path
              d="M1.4 1.4l7.2 7.2M8.6 1.4L1.4 8.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </svg>
        </button>
      </div>
    </div>
  )
}
