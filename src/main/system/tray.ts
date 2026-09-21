/**
 * 系统托盘（Phase 3）。
 *
 * 存在的理由不是「好看」，而是**进程常驻**：提醒引擎和桌面小组件都要求应用活着。
 * 而这台机器上的默认行为是「关掉窗口 = 应用退出」，用户合上主窗口的瞬间
 * 提醒就全失效了 —— 这是提醒类应用最典型的静默故障。
 *
 * 所以：close 事件被拦下来改成 hide，真正退出只走托盘菜单和设置页的按钮。
 * 用户可以在设置里关掉 `closeToTray` 回到旧行为（给了开关，而不是替他决定）。
 */

import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
// 品牌图标（唯一源 scripts/todolist-{16,32}x*.png，gen-icons.mjs 装配产出）。
// 托盘直接用**逐档手工像素**的 16/32 两档，不再从大图缩放 ——
// 源图是为小尺寸专门对过像素的，任何运行时重采样都会把锯齿带回来
import trayIcon16 from '../../../resources/icon-16.png?asset'
import trayIcon32 from '../../../resources/icon-32.png?asset'

export interface TrayCallbacks {
  /** 显示并聚焦主窗口 */
  showMain: () => void
  /** 显示主窗口并跳到看板页 */
  openBoard: () => void
  /** 手动跑一次提醒调度（让用户能主动确认引擎是活的） */
  checkNow: () => void
  /** 真正退出（跳过 closeToTray 拦截） */
  quit: () => void
}

/**
 * 托盘图标。
 *
 * 双档位表示：100% DPI 下系统要 16px、200% 要 32px，
 * 分别对应 resources/icon-16.png / icon-32.png 两张手工处理过的图，
 * 由系统按 DPI 自选，不做任何缩放。
 * （不再用 gen-tray-icon.mjs 生成的内联 base64 简化图 —— 用户要求托盘也用正式
 * 品牌图；该脚本保留作历史参考，不再被引用。）
 *
 * 历史教训仍然有效：手写占位 base64 会让 createFromDataURL 静默得到空图，
 * 托盘显示白块且无任何报错 —— 所以下面显式 isEmpty() 兜底回退 data URL 的旧图。
 */
const FALLBACK_PNG_DATA_URL =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAApUlEQVR42tWXQQ7AIAgE+Y3x5v+f4Kfak01qTAVdWEvilZmCbUHkI1IuF+KIJVIuFQUenCoRT7xUkSj4UMK57PN2EODvKlAFWPBHwitxC4pAH6ECo6AKhLbACocKWEsPFViFqwQ0CVfhUwFN4h24WaAH7JTe3IIegoCrL6Em3P8FHnDza0gXQNx6yIcIBXedB34xFR01lHLHcvpicsRqdsRyyljPbx6Ga24oZY2aAAAAAElFTkSuQmCC'

export class TrayService {
  private tray: Tray | null = null

  constructor(private readonly callbacks: TrayCallbacks) {}

  /** 幂等：重复调用不会创建第二个托盘图标 */
  create(): void {
    if (this.tray) return

    const icon = nativeImage.createEmpty()
    icon.addRepresentation({ scaleFactor: 1, buffer: readFileSync(trayIcon16) })
    icon.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayIcon32) })
    const finalIcon = icon.isEmpty()
      ? // 防线：路径在 dev/打包后失效时不能让托盘变白块 —— 回退旧的内联图
        nativeImage.createFromDataURL(FALLBACK_PNG_DATA_URL)
      : icon
    this.tray = new Tray(finalIcon)
    this.tray.setToolTip('TodoList —— 提醒引擎运行中')
    this.tray.setContextMenu(this.buildMenu())

    // 左键单击直接显示主窗口（Windows 上托盘图标的默认预期行为）
    this.tray.on('click', this.callbacks.showMain)
  }

  private buildMenu(): Menu {
    return Menu.buildFromTemplate([
      { label: '显示主窗口', click: this.callbacks.showMain },
      { label: '打开看板', click: this.callbacks.openBoard },
      { type: 'separator' },
      { label: '立即检查提醒', click: this.callbacks.checkNow },
      { type: 'separator' },
      { label: '退出 TodoList', click: this.callbacks.quit }
    ])
  }

  setTooltip(text: string): void {
    this.tray?.setToolTip(text)
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}

/**
 * 关窗拦截：把「关闭」变成「隐藏」。
 *
 * 注意 `win.isQuitting` 这个标记 —— 没有它就会出现「点了退出但窗口又弹回来」
 * 或者更糟的「永远退不掉」。它必须由调用方在真正退出前置为 true。
 */
export function attachCloseToTray(
  win: BrowserWindow,
  shouldHide: () => boolean,
  onHidden?: () => void
): void {
  win.on('close', (e) => {
    if ((win as BrowserWindow & { isQuitting?: boolean }).isQuitting) return
    if (!shouldHide()) return
    e.preventDefault()
    win.hide()
    onHidden?.()
  })
}

/** 真正退出前调用，解除所有关窗拦截 */
export function markQuitting(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) {
    ;(win as BrowserWindow & { isQuitting?: boolean }).isQuitting = true
  }
}

/**
 * 开机启动。
 *
 * `openAtLogin` 用 Electron 内置实现（写注册表 Run 键），不自己拼注册表路径 ——
 * 后者在「应用路径变了」「用户手动删了快捷方式」这些情况下会留下垃圾项。
 *
 * 注意：未打包时 args 需要指向项目目录，否则开机启动会去启动 electron.exe 本身
 * 而找不到入口。这里按 `app.isPackaged` 区分，开发模式下也让它可用（方便测试）。
 */
export function applyLaunchAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      ...(app.isPackaged ? {} : { args: [process.cwd()] })
    })
  } catch {
    // 某些受限环境下写注册表会失败，不该因为它让设置页报错
  }
}
