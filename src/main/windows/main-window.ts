import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { IPC } from '@shared/types'
// 品牌图标（scripts/todolist-256x256.png 的下游，gen-icons.mjs 装配产出）。
// Windows 上 BrowserWindow 的 icon 同时决定：窗口图标 + 任务栏图标；
// 打包成 exe 后任务栏改用 exe 内嵌图标（build/icon.ico），两者同源一致
import appIcon from '../../../resources/icon.png?asset'

/**
 * 主窗口。
 *
 * 尺寸修正说明：原《01-UI设计规范》§1 写的是 460×640，那是「单列 TodoList」时代的尺寸。
 * 改成 Sidebar + 三列看板后，460 已经放不下三列。故默认窗口调整为 1080×720。
 *
 * 最小尺寸策略（v1.3）：**最小窗口 = 默认窗口尺寸（1080×720）**。
 * 即应用打开多大，就允许缩小到多大，再小不允许 —— 保证打开时的布局
 * （Sidebar + 三列看板）永远完整，用户只能放大、不能缩小。
 * 三列宽度已在 CSS 端改为随内容区弹性拉伸（无 max-width），放大后看板铺满。
 *
 * 窗口形态（《UI优化》§8–§10）：**无边框 frameless**，标题栏由渲染层 TitleBar 自绘。
 * 关键取舍：`frame:false` 但**不关 thickFrame** —— 在 Windows 上 thickFrame 决定的是
 * 「有没有系统级缩放边框 / Aero Snap / 双击最大化 / DPI 正确的非客户区」。关掉它窗口会失去
 * 拖拽缩放与贴边，只能靠 JS 手写，得不偿失（固定尺寸的小组件窗口才该关）。
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    // 最小尺寸 = 默认尺寸：打开多小就能缩小到多小，不允许更小
    minWidth: 1080,
    minHeight: 720,
    show: false,
    frame: false,
    icon: appIcon,
    backgroundColor: '#FAFAFA',
    autoHideMenuBar: true,
    title: 'TodoList',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // 最大化状态要同步给渲染层，自绘按钮才能切换「最大化 / 还原」图标。
  // 除按钮外还有三条路径会改变它：双击拖拽区、Win+↑、Aero Snap —— 事件都覆盖
  const pushState = (): void => {
    if (win.isDestroyed()) return
    win.webContents.send(IPC.windowState, { maximized: win.isMaximized() })
  }
  win.on('maximize', pushState)
  win.on('unmaximize', pushState)

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    // 支持通过 TODO_PAGE / TODO_EDIT 深链（托盘「打开看板」、自动化截图、验图都用它）。
    // TODO_EDIT=first 表示加载完成后自动打开第一条任务的编辑器 ——
    // 弹层类界面没法靠一张静态截图验证，必须真的把它打开。
    const page = process.env['TODO_PAGE']
    const edit = process.env['TODO_EDIT']
    const qr = process.env['TODO_QR']
    const logs = process.env['TODO_LOGS']
    const params = new URLSearchParams()
    if (page) params.set('page', page)
    if (edit) params.set('edit', edit)
    if (qr) params.set('qr', qr)
    if (logs) params.set('logs', logs)
    const search = params.toString()
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      search: search ? `?${search}` : undefined
    })
  }

  return win
}
