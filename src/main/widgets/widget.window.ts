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
import {
  clampWidgetSize,
  WIDGET_MAX_H,
  WIDGET_MAX_W,
  WIDGET_MIN_H,
  WIDGET_MIN_W,
  type AppSettings
} from '@shared/types'

/** 距屏幕右下角的边距。默认贴在右下角，避开常见的任务栏图标区 */
const MARGIN = 24

export interface WidgetBounds {
  x: number | null
  y: number | null
}

/** 小组件的尺寸。默认值放在 @shared/types 的 DEFAULT_SETTINGS 里（300×420） */
export interface WidgetSize {
  w: number
  h: number
}

/**
 * 计算小组件的初始位置。
 *
 * 关键点：**用当前工作区（workArea）而不是整屏尺寸** —— 任务栏高度会被算进去，
 * 否则窗口下沿会被任务栏压住。另外必须校验记忆的坐标是否还在可见的显示器范围内：
 * 用户可能拔掉了外接显示器，此时旧坐标会把窗口丢到屏幕外，表现为「小组件不见了」。
 *
 * ⚠ size 必须由调用方传入**实际宽高**，不能用常量：
 * v1.6 加入缩放后，窗口大小不再固定，沿用 300×420 判断可见性会让「右下角的大尺寸
 * 小组件」被误判成越界而弹回默认位置。
 */
export function resolveWidgetPosition(
  bounds: WidgetBounds,
  size: WidgetSize
): { x: number; y: number } {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea

  const fallback = {
    x: Math.round(area.x + area.width - size.w - MARGIN),
    y: Math.round(area.y + area.height - size.h - MARGIN)
  }

  if (bounds.x === null || bounds.y === null) return fallback

  // 只要窗口还有一小块落在工作区内就认为坐标有效，否则回落到默认位置
  const visible =
    bounds.x + size.w > area.x &&
    bounds.x < area.x + area.width &&
    bounds.y + size.h > area.y &&
    bounds.y < area.y + area.height
  return visible ? { x: bounds.x, y: bounds.y } : fallback
}

/**
 * 缩放锁定的唯一判据。集中在一处，主进程与渲染层的说法就不会打架。
 *
 * 需求：「点了置顶就锁定缩放功能」—— 置顶的小组件是用户主动钉在桌面上的，
 * 这时它不该再被拖动右边或下边改变尺寸。取消置顶即恢复。
 *
 * ⚠ 实测坑（2026-09-20 探针验证）：Windows 上 `resizable: false` 出生的 frameless
 * 窗口，`setResizable(true)` 并**不会**真的把它变回可缩放 —— 之后 setSize 仍然生效，
 * 但用户在边框上拖不动。所以这里只当作「意图」；窗口真正的能力必须读
 * `win.isResizable()`，对外上报一律以它为准（见 index.ts 的 widgetStatus）。
 */
export function widgetResizeLock(alwaysOnTop: boolean): 'alwaysOnTop' | null {
  return alwaysOnTop ? 'alwaysOnTop' : null
}

/**
 * 把窗口的实际宽高对齐到设置记忆值（夹到合法区间）。
 * 创建时与「外部改尺寸」时都要走一遍。
 */
export function resolveWidgetSize(settings: AppSettings): WidgetSize {
  return clampWidgetSize(settings.widgetW, settings.widgetH)
}

export function createWidgetWindow(
  settings: AppSettings,
  devUrl: string | undefined,
  onMoved: (x: number, y: number) => void,
  onResized: (w: number, h: number) => void
): BrowserWindow {
  const size = resolveWidgetSize(settings)
  const pos = resolveWidgetPosition({ x: settings.widgetX, y: settings.widgetY }, size)
  const locked = widgetResizeLock(settings.widgetAlwaysOnTop) !== null

  const win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    // 允许缩放的前提是**当前没被锁定**。置顶时直接以不可缩放的状态出生，
    // 免得窗口先可拖一帧再被锁（那一帧里 DWM 会画出缩放边框）
    //
    // ⚠ 易错点：`transparent: true` 单独出现时 Electron 会把 resizable 默认成 false，
    // 必须同时给 `frame: false` 才能保住 resizable。三个选项是一组，删任何一个都会
    // 让「透明便签 + 可缩放」其中一个失效（探针实测确认）。
    resizable: !locked,
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

  // 尺寸下限：不设的话用户能把小组件拖成一条缝，头部按钮全挤在一起没法恢复。
  // 上限交给 setMaximumSize —— 超过就不像桌面挂件了
  win.setMinimumSize(WIDGET_MIN_W, WIDGET_MIN_H)
  win.setMaximumSize(WIDGET_MAX_W, WIDGET_MAX_H)

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

  // ⚠ 用 'resized' 而不是 'resize'：'resize' 在拖拽过程中持续触发（每秒几十次），
  // 每次都写库既浪费又会让设置页的数字疯狂跳动。'resized' 只在拖拽/系统调整结束后
  // 触发一次 —— 与 'moved' 是同一套设计。
  //
  // 代价：程序化 setSize（设置页档位）不会触发 'resized'，所以主进程必须自己写库
  //（index.ts 的 setWidgetSize）。两处都写同一条 key，先到先用，不会互相覆盖出脏值。
  win.on('resized', () => {
    const [w, h] = win.getSize()
    const fixed = clampWidgetSize(w, h)
    onResized(fixed.w, fixed.h)
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

/**
 * 运行时切换缩放的可用性（置顶开关翻转时调用）。
 *
 * 为什么必须放在主进程而不是渲染层：「能不能缩放」是**窗口级**能力，
 * 渲染层的 CSS 手柄只是入口。只隐藏手柄而不动 setResizable，
 * 用户仍能通过系统快捷键/自动化改尺寸 —— 锁定必须是真的锁住。
 */
export function applyWidgetResizable(win: BrowserWindow, alwaysOnTop: boolean): void {
  if (win.isDestroyed()) return
  win.setResizable(widgetResizeLock(alwaysOnTop) === null)
}
