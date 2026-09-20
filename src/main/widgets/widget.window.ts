/**
 * 桌面小组件窗口（Phase 3 / 需求 §12）。
 *
 * 形态：无边框 + 透明 + 不出现在任务栏。这是一张「贴在桌面上的便签」，
 * 不是第二个主窗口 —— 所以它没有标题栏、没有最小化、也不该占 Alt+Tab 的位置。
 *
 * Win10 限制（v0.2 已定调）：Acrylic 毛玻璃是 Win11 API，本机 19045 只能做到
 * **均匀半透明**，没有背景模糊。不引第三方 blur-behind —— 那需要注入 DLL，
 * 代价远大于收益。
 *
 * 位置记忆写在 settings 里而不是浏览器 localStorage：
 * 主进程需要在创建窗口时就知道坐标（否则会先闪一个默认位置再跳过去）。
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import type { AppSettings } from '@shared/types'

const WIDGET_W = 300
const WIDGET_H = 420
/** 距屏幕右下角的边距。默认贴在右下角，避开常见的任务栏图标区 */
const MARGIN = 24

export interface WidgetBounds {
  x: number | null
  y: number | null
}

/**
 * 计算小组件的初始位置。
 *
 * 关键点：**用当前工作区（workArea）而不是整屏尺寸** —— 任务栏高度会被算进去，
 * 否则窗口下沿会被任务栏压住。另外必须校验记忆的坐标是否还在可见的显示器范围内：
 * 用户可能拔掉了外接显示器，此时旧坐标会把窗口丢到屏幕外，表现为「小组件不见了」。
 */
export function resolveWidgetPosition(bounds: WidgetBounds): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea

  const fallback = {
    x: Math.round(area.x + area.width - WIDGET_W - MARGIN),
    y: Math.round(area.y + area.height - WIDGET_H - MARGIN)
  }

  if (bounds.x === null || bounds.y === null) return fallback

  // 只要窗口还有一小块落在工作区内就认为坐标有效，否则回落到默认位置
  const visible =
    bounds.x + WIDGET_W > area.x &&
    bounds.x < area.x + area.width &&
    bounds.y + WIDGET_H > area.y &&
    bounds.y < area.y + area.height
  return visible ? { x: bounds.x, y: bounds.y } : fallback
}

export function createWidgetWindow(
  settings: AppSettings,
  devUrl: string | undefined,
  onMoved: (x: number, y: number) => void
): BrowserWindow {
  const pos = resolveWidgetPosition({ x: settings.widgetX, y: settings.widgetY })

  const win = new BrowserWindow({
    width: WIDGET_W,
    height: WIDGET_H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    // 不出现在任务栏和 Alt+Tab 里 —— 它是桌面挂件，不是独立应用窗口
    skipTaskbar: true,
    hasShadow: false,
    // ⚠ 必须显式关掉：Windows 上 frameless 窗口默认 thickFrame=true，
    // DWM 仍会给窗口矩形画一圈边框+阴影 —— 表现就是小组件外面套个方形影子框。
    // 关掉后连窗口动画一起移除（小组件没有最小化/还原动画，无损失）
    thickFrame: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.setAlwaysOnTop(settings.widgetAlwaysOnTop)
  if (settings.widgetAlwaysOnTop) {
    // 'normal' 级别只在同级窗口内保持置顶，不会像 'screen-saver' 那样盖住系统弹窗
    win.setAlwaysOnTop(true, 'normal')
  }

  // 拖动结束后才记位置：drag 过程中会高频触发 move，每次都写库是浪费
  win.on('moved', () => {
    const [x, y] = win.getPosition()
    onMoved(x, y)
  })

  const dev = devUrl
  if (dev) {
    // dev server 下用查询串区分入口 —— 同一个 vite server 服务两个页面
    void win.loadURL(`${dev}/widget.html`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/widget.html'))
  }

  win.once('ready-to-show', () => {
    if (settings.widgetEnabled) win.showInactive()
  })

  return win
}
