import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { dirname, resolve } from 'path'
import {
  clampWidgetSize,
  IPC,
  type AppSettings,
  type CreateTaskInput,
  type MoveTarget,
  type TaskPatch,
  type WindowResizedEvent
} from '@shared/types'
import type { CaptureTarget } from '@shared/capture-parse'
import type { AppContext } from './context'
import type { ListScope } from '../core/task/task.service'
import { applyLaunchAtLogin } from '../system/tray'
import { migrateDbFile, writeCustomDbDir } from '../services/config/db-location'
// 注意：函数参数名是 app（AppContext），Electron 的 app 必须改名引入避免遮蔽
import { app as electronApp } from 'electron'

/**
 * 所有 ipcMain 通道的单一注册入口。
 * 渲染层拿到的只有 preload 白名单里那几个方法，通道名集中定义在 @shared/types 的 IPC 常量里。
 */
export function registerIpc(app: AppContext): void {
  const { tasks, settings, notifications, scheduler, broadcastTasksChanged } = app
  ipcMain.handle(IPC.board, () => tasks.board())

  // ── 无边框主窗口的自绘标题栏（《UI优化》§8–§10）──
  // 统一用 fromWebContents 反查发起窗口，而不是持有 mainWindow 引用：
  // 这样将来从小组件或第二个窗口调用同一套 API 也不会误操作到主窗口
  const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.handle(IPC.windowMinimize, (e) => {
    senderWindow(e)?.minimize()
  })

  ipcMain.handle(IPC.windowToggleMaximize, (e) => {
    const win = senderWindow(e)
    if (!win) return { maximized: false }
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { maximized: win.isMaximized() }
  })

  ipcMain.handle(IPC.windowClose, (e) => {
    // 走 win.close() 而不是 destroy()：关窗到托盘的拦截钩子挂在 'close' 事件上，
    // 继承自绘标题栏的关闭按钮必须与系统关闭行为完全一致（§13.9 防线）
    senderWindow(e)?.close()
  })

  ipcMain.handle(IPC.list, (_e, scope: ListScope) => tasks.list(scope))

  ipcMain.handle(IPC.search, (_e, query: unknown) => tasks.search(typeof query === 'string' ? query : ''))

  ipcMain.handle(IPC.counts, () => tasks.counts())

  // 捕获条唯一入口：只收原始文本 + 默认落点，解析在主进程做
  ipcMain.handle(IPC.capture, (_e, raw: string, target: CaptureTarget) => {
    const result = tasks.capture(raw, target)
    if (result.ok) broadcastTasksChanged()
    return result
  })

  // 编辑器「新建任务」：字段已在编辑器里被用户显式选定（日期选择器而非自然语言），
  // 所以这里直接结构化传入，与 capture 的「不可信解析字段」约定不冲突。
  // 走的是 task.service.create —— 提醒默认值快照、事务内 replan 都在那一条路径上。
  ipcMain.handle(IPC.create, (_e, input: CreateTaskInput) => {
    const task = tasks.create(input)
    broadcastTasksChanged()
    return task
  })

  ipcMain.handle(IPC.toggle, (_e, id: string) => {
    const task = tasks.toggle(id)
    broadcastTasksChanged()
    return task
  })

  // 看板拖拽：原子操作，字段变更 + 提醒重算在同一事务
  ipcMain.handle(IPC.moveTask, (_e, id: string, target: MoveTarget) => {
    const task = tasks.moveTask(id, target)
    broadcastTasksChanged()
    return task
  })

  ipcMain.handle(IPC.update, (_e, id: string, patch: TaskPatch) => {
    const task = tasks.update(id, patch)
    broadcastTasksChanged()
    return task
  })

  ipcMain.handle(IPC.remove, (_e, id: string) => {
    const ok = tasks.remove(id)
    broadcastTasksChanged()
    return ok
  })

  ipcMain.handle(IPC.tags, () => tasks.listTags())

  ipcMain.handle(IPC.settingsGet, () => settings.all())

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const before = settings.all()
    const next = settings.set(patch)

    // §23 要求：改了「通知方式」这类全局设置要重新计算提醒计划。
    // 因为这些开关会改变每个任务的 effectiveChannel —— 只在任务侧 replan 是不够的。
    if (NOTIFY_SETTING_KEYS.some((k) => k in patch)) {
      const r = notifications.recoverAndReplanAll()
      console.log(`[notify] 设置变更触发全量重排：${r.plans}/${r.tasks} 个任务有提醒计划`)
    }

    // 开机启动：以设置值为准同步到系统（Electron 内部会去写/删注册表 Run 项）
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      applyLaunchAtLogin(next.launchAtLogin)
    }

    // 小组件开关 / 置顶：需要真正创建或销毁窗口，不只是存个值
    if (WIDGET_SETTING_KEYS.some((k) => k in patch)) {
      app.syncWidgetWindow()
    }

    // 主题切换即时生效：themeSource 覆盖系统偏好，所有窗口的
    // prefers-color-scheme 跟着变，CSS 无需 reload
    if (patch.theme !== undefined && patch.theme !== before.theme) {
      nativeTheme.themeSource = next.theme
    }

    broadcastTasksChanged()
    return next
  })

  // ── 桌面小组件 ──
  ipcMain.handle(IPC.widgetStatus, () => app.widgetStatus())

  ipcMain.handle(IPC.widgetSetEnabled, (_e, enabled: boolean) => {
    settings.set({ widgetEnabled: enabled })
    app.syncWidgetWindow()
    return app.widgetStatus()
  })

  ipcMain.handle(IPC.widgetSetAlwaysOnTop, (_e, on: boolean) => {
    // settings.set 之后 syncWidgetWindow 会把 setResizable(!on) 一起同步 ——
    // 「置顶即锁定缩放」这条规则只写在 syncWidgetWindow 一处，不在 handler 里重复判断
    settings.set({ widgetAlwaysOnTop: on })
    app.syncWidgetWindow()
    return app.widgetStatus()
  })

  // 小组件拖动右下角手柄结束后上报（'resized' 事件对渲染层 resizeTo 不可靠，
  // 所以由渲染层在 pointerup 时显式提交；尺寸由**主进程读自己的窗口**得到 ——
  // 渲染层同步读 innerWidth 拿到的是 resizeTo 应用前的旧值，不能信）
  ipcMain.handle(IPC.widgetResized, (e) => {
    // ⚠ 必须校验来源：只有真正的小组件窗口才能改小组件尺寸。
    // 主窗口的渲染层也持有同一个 preload，不校验的话主窗口能直接改小组件窗口大小
    if (!isWidgetSender(e)) return app.widgetStatus()
    const locked = settings.all().widgetAlwaysOnTop
    if (locked) return app.widgetStatus()
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return app.widgetStatus()
    const [gw, gh] = win.getSize()
    const size = clampWidgetSize(gw, gh)
    settings.set({ widgetW: size.w, widgetH: size.h })
    // 不广播 tasksChanged：尺寸变化与任务数据无关，广播会让小组件白刷一次列表
    return app.widgetStatus()
  })

  // 设置页的尺寸档位：交给主进程真正 setSize
  ipcMain.handle(IPC.widgetSetSize, (_e, w: number, h: number) => {
    app.setWidgetSize(Number(w), Number(h))
    return app.widgetStatus()
  })

  // 小组件启动时问一次「我现在能不能缩放」，用于初始化手柄的禁用态
  ipcMain.handle(IPC.widgetResizeState, (e) => {
    if (!isWidgetSender(e)) return { resizable: false, lockedBy: 'alwaysOnTop' as const }
    return widgetResizeState(app)
  })

  // 小组件里点击任务 / 点标题栏按钮 → 显示主窗口（有 taskId 则定位高亮）
  ipcMain.handle(IPC.widgetOpenMain, (_e, taskId: string | null) => {
    app.openAndLocate(taskId && taskId.length > 0 ? taskId : null)
  })

  // ── PushPlus ──
  ipcMain.handle(IPC.pushplusCheck, () => app.pushplusCheck())

  ipcMain.handle(IPC.notifyStatus, () => notifications.status(scheduler.isRunning()))

  ipcMain.handle(IPC.notifyLogs, (_e, limit?: number) => notifications.history(limit ?? 30))

  ipcMain.handle(IPC.notifyTest, async () => notifications.sendTest())

  // 设置页的「立即检查」：手动跑一次调度，并把取数窗口放宽到 60 秒，
  // 让用户当场就能看到效果，而不是盯着表等 30 秒
  ipcMain.handle(IPC.notifyTick, async () => {
    const result = await scheduler.tick('manual')
    broadcastTasksChanged()
    return { status: notifications.status(scheduler.isRunning()), result }
  })

  ipcMain.handle(IPC.notifyRetry, async (_e, logId: string) => {
    const ok = notifications.retryLog(logId)
    if (ok) await scheduler.tick('manual')
    return ok
  })

  ipcMain.handle(IPC.revealDb, async () => {
    shell.showItemInFolder(app.dbPath)
    return dirname(app.dbPath)
  })

  ipcMain.handle(IPC.dbPath, () => app.dbPath)

  // ── 更改数据存储位置 ──
  // 流程：弹目录选择框 → 停调度器 → 关库 → 拷贝 sqlite 文件 → 写位置配置 → 重启应用。
  // 迁移必须重启：所有 service 都握着旧 db 句柄，运行时换连接等于全链路重装配，
  // 风险远大于「重启一次」的成本（Electron relaunch 对用户就是闪一下窗口）
  ipcMain.handle(IPC.changeDbDir, async () => {
    const pick = await dialog.showOpenDialog({
      title: '选择数据存储位置',
      defaultPath: dirname(app.dbPath),
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || pick.filePaths.length === 0) return { ok: false, canceled: true }
    const newDir = pick.filePaths[0]
    if (resolve(newDir) === resolve(dirname(app.dbPath))) {
      return { ok: false, error: '选择的已是当前存储位置' }
    }
    try {
      app.scheduler.stop()
      app.db.close()
      migrateDbFile(app.dbPath, newDir)
      writeCustomDbDir(electronApp.getPath('userData'), newDir)
      electronApp.relaunch()
      electronApp.quit()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 改动这些设置必须触发全量重排 */
const NOTIFY_SETTING_KEYS: Array<keyof AppSettings> = [
  'desktopNotifyEnabled',
  'wechatNotifyEnabled',
  'overduePolicy'
]

/**
 * 改动这些设置需要真正创建/销毁小组件窗口。
 * widgetScope / widgetW / widgetH 刻意不在这里：它们只影响小组件自身，
 * 不需要重建窗口 —— 尺寸由 setWidgetSize 直接改，重取数由 broadcastTasksChanged 叫醒。
 */
const WIDGET_SETTING_KEYS: Array<keyof AppSettings> = [
  'widgetEnabled',
  'widgetAlwaysOnTop'
]

/**
 * 发起方是不是小组件窗口。
 *
 * 判断依据：这个 BrowserWindow 的页面 URL 指向 widget.html。
 * 不去比对窗口实例 —— 小组件窗口会被 syncWidgetWindow 销毁重建，
 * 持有一份引用反而更容易过期。
 *
 * 为什么要校验：preload 是共享的，主窗口渲染层也能 invoke 这些通道。
 * 「主窗口能改小组件尺寸」虽不致命，但会让「谁在改尺寸」失去唯一答案。
 */
function isWidgetSender(e: Electron.IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isDestroyed()) return false
  const url = win.webContents.getURL()
  return url.includes('widget.html')
}

/** 从 AppContext 推导缩放可用性（判据只有「是否置顶」一条） */
function widgetResizeState(app: AppContext): WindowResizedEvent {
  const locked = app.widgetStatus().resizeLockedBy !== null
  return { resizable: !locked, lockedBy: locked ? 'alwaysOnTop' : null }
}
