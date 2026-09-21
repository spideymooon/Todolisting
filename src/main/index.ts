import { app, BrowserWindow, nativeTheme } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { openDatabase } from './core/database/connection'
import { runMigrations } from './core/database/migrate'
import { migrations } from './core/database/migrations'
import { TaskRepository } from './core/task/task.repository'
import { TaskService, type NewTaskReminderDefaults } from './core/task/task.service'
import { NotificationService } from './core/notification/notification.service'
import type { ReminderDefaults } from '@shared/reminder-plan'
import { SettingsService } from './services/config/settings.service'
import { readCustomDbDir } from './services/config/db-location'
import { WindowsNotifier } from './services/notification/windows-notifier'
import { PushPlusNotifier } from './services/notification/pushplus-notifier'
import { SchedulerService } from './services/notification/scheduler.service'
import { TrayService, applyLaunchAtLogin, attachCloseToTray, markQuitting } from './system/tray'
import { APP_USER_MODEL_ID, ensureDevStartMenuShortcut, ensureInstalledShortcutAumid } from './system/dev-shortcut'
import { createWidgetWindow } from './widgets/widget.window'
import { seedSampleData } from './seed'
import { registerIpc } from './ipc/register-ipc'
import { createMainWindow } from './windows/main-window'
import { maybeScheduleScreenshot } from './dev/screenshot'
import { maybeRunE2eSync } from './dev/e2e-sync'
import type { AppContext } from './ipc/context'
import { IPC, type AppSettings, type NotifyChannel, type WidgetStatus } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let appContext: AppContext | null = null
let windowsNotifier: WindowsNotifier | null = null
let pushplusNotifier: PushPlusNotifier | null = null
let tray: TrayService | null = null

/**
 * Windows 的 toast 通知需要 AppUserModelID 才能被系统正确识别与归组。
 *
 * 任务栏图标按 AUMID 分组取图：AUMID 注册的快捷方式 → exe 内嵌图标。
 * 打包后安装器创建的快捷方式自带 AUMID + exe 图标，直接 set 即可。
 * 开发态跑在 electron.exe 上，只设 AUMID 会找不到注册快捷方式、回退到
 * exe 图标（Explorer 还有缓存，实测反复回吐原子图）——所以必须**同时**
 * 在开始菜单注册一个带相同 AUMID + 品牌图标的快捷方式（dev-shortcut.ts），
 * 任务栏图标才恒定为品牌图。
 */
if (app.isPackaged) {
  app.setAppUserModelId('com.desktoptodo.app')
  // 安装器创建的快捷方式不带 AUMID（electron-builder NSIS 行为），任务栏
  // 按 AUMID 找不到就显示通用图标 —— 启动时补写（幂等，重复执行无害）
  ensureInstalledShortcutAumid()
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID)
  ensureDevStartMenuShortcut()
}

function broadcastTasksChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.tasksChanged)
  }
}

/** 全局开关 → 新任务的通道初值 */
function resolveChannels(s: AppSettings): NotifyChannel {
  if (s.desktopNotifyEnabled && s.wechatNotifyEnabled) return 'both'
  if (s.desktopNotifyEnabled) return 'desktop'
  if (s.wechatNotifyEnabled) return 'wechat'
  return 'none'
}

/**
 * 打开主窗口并定位到某个任务（点击通知时调用，§5）。
 *
 * 这里有个容易漏的时序问题：如果主窗口刚被创建、渲染层还没订阅 `task:locate`，
 * 直接 send 会**静默丢失**。所以加载中的窗口要等 did-finish-load 再发。
 */
function openAndLocate(taskId: string | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
    attachMainWindowHooks(mainWindow)
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()

  if (!taskId) return

  const send = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.locateTask, taskId)
    }
  }
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/**
 * 关窗拦截：把「关闭」变成「隐藏到托盘」。
 *
 * 抽成函数是因为主窗口有两个创建点（启动时、以及 openAndLocate 的兜底重建），
 * 漏掉任何一处都会出现「有时能常驻、有时关掉就退」的随机行为。
 */
function attachMainWindowHooks(win: BrowserWindow): void {
  attachCloseToTray(
    win,
    () => appContext?.settings.all().closeToTray ?? true,
    () => {
      // 隐藏后提示一次托盘还在 —— 否则用户会以为应用被关掉了（§22 同类问题）
      windowsNotifier?.notifyHiddenToTray()
    }
  )

  win.on('focus', () => {
    win.webContents.send(IPC.captureFocus)
  })
}

/** 小组件窗口的创建 / 销毁 / 配置同步。设置变更与启动时都调它 */
function syncWidgetWindow(): void {
  const settings = appContext?.settings.all()
  if (!settings) return

  if (!settings.widgetEnabled) {
    if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.destroy()
    widgetWindow = null
    return
  }

  if (!widgetWindow || widgetWindow.isDestroyed()) {
    widgetWindow = createWidgetWindow(
      settings,
      process.env['ELECTRON_RENDERER_URL'],
      (x, y) => {
        // 位置记忆：只在拖动结束后写一次，避免拖动过程高频写库
        void appContext?.settings.set({ widgetX: x, widgetY: y })
      }
    )
    return
  }

  // 已存在 → 同步置顶与可见性
  widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop)
  if (!widgetWindow.isVisible()) widgetWindow.showInactive()
}

function widgetStatus(): WidgetStatus {
  const settings = appContext?.settings.all()
  return {
    enabled: settings?.widgetEnabled ?? false,
    visible: !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible(),
    alwaysOnTop: settings?.widgetAlwaysOnTop ?? false
  }
}

function bootstrap(): AppContext {
  const userData = app.getPath('userData')
  // 存储位置支持用户自定义（设置页「更改目录」）：自定义目录记在 userData 的
  // db-location.json 里 —— 配置本身不能放数据库里，否则换完目录就找不到配置了
  const dbDir = readCustomDbDir(userData) ?? userData
  const dbPath = join(dbDir, 'todo.sqlite')
  const existedBefore = existsSync(dbPath)

  const { db } = openDatabase(dbPath, existedBefore)
  const migrationResult = runMigrations(db, migrations)
  console.log(
    `[db] ${dbPath}\n[db] migrations: ${migrationResult.applied.length ? migrationResult.applied.join(', ') : 'none'} (v${migrationResult.from} → v${migrationResult.to})`
  )

  const settings = new SettingsService(db)
  const repo = new TaskRepository(db)

  // 装配顺序有依赖：tasks 的 replan 钩子指向 notifications，
  // notifications 又通过 repo 读任务。所以先建 notifications，再建 tasks。
  windowsNotifier = new WindowsNotifier(openAndLocate)
  pushplusNotifier = new PushPlusNotifier(() => {
    const s = settings.all()
    return { token: s.pushplusToken, topic: s.pushplusTopic }
  })

  const notifications = new NotificationService(
    db,
    repo,
    (): ReminderDefaults => {
      const s = settings.all()
      return {
        overduePolicy: s.overduePolicy,
        desktopNotifyEnabled: s.desktopNotifyEnabled,
        wechatNotifyEnabled: s.wechatNotifyEnabled
      }
    },
    // 两个通道都注册。微信通道在 token 未配置时 send() 返回「未配置 token」，
    // 日志里可见，但不影响任务操作（§19）
    { desktop: windowsNotifier, wechat: pushplusNotifier }
  )

  const reminderDefaults = (): NewTaskReminderDefaults => {
    const s = settings.all()
    return {
      reminderEnabled: s.defaultReminderEnabled,
      reminderDays: s.defaultReminderDays,
      reminderTime: s.defaultReminderTime,
      notifyChannels: resolveChannels(s)
    }
  }

  const tasks = new TaskService(
    db,
    (taskId) => {
      notifications.plan(taskId)
    },
    reminderDefaults,
    repo
  )

  const scheduler = new SchedulerService(notifications)

  if (!existedBefore) {
    const n = seedSampleData(tasks)
    console.log(`[db] 首次启动，写入 ${n} 条示例任务`)
  }

  const context: AppContext = {
    db,
    dbPath,
    tasks,
    settings,
    notifications,
    scheduler,
    broadcastTasksChanged,
    openAndLocate,
    widgetStatus,
    syncWidgetWindow,
    pushplusCheck: () => pushplusNotifier!.check()
  }
  registerIpc(context)
  return context
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  // 防线 3（§4.2）：§23 点名的「程序重复启动导致重复通知」靠这一行挡住
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户又双击了图标 → 把主窗口叫出来，而不是再开一个进程
    openAndLocate(null)
  })

  app.whenReady().then(() => {
    try {
      appContext = bootstrap()
    } catch (err) {
      console.error('[boot] 初始化失败', err)
      throw err
    }

    // 开机启动状态以设置为准同步一次（用户可能在任务管理器里手动关掉过）
    const s = appContext.settings.all()
    applyLaunchAtLogin(s.launchAtLogin)

    // 主题以设置为准：nativeTheme.themeSource 会覆盖系统偏好，
    // 让所有渲染层（主窗 + 小组件）的 prefers-color-scheme 直接跟随设置值。
    // CSS 端只有一套 @media (prefers-color-scheme: dark) 规则，不需要感知这个字段
    nativeTheme.themeSource = s.theme

    // 启动时先做一次崩溃恢复 + 全量重排，保证每个任务恰好有一条当前计划 ——
    // 否则上次退出时残留的旧计划会在启动瞬间一起触发
    const recovery = appContext.notifications.recoverAndReplanAll()
    console.log(
      `[notify] 启动恢复：修复 ${recovery.recovered} 条中断计划，${recovery.tasks} 个未完成任务中 ${recovery.plans} 个有提醒计划`
    )
    appContext.scheduler.start()

    // 托盘先于窗口创建：关窗拦截依赖托盘存在（否则隐藏后用户没有入口找回来）
    tray = new TrayService({
      showMain: () => openAndLocate(null),
      openBoard: () => openAndLocate(null),
      checkNow: () => {
        void appContext?.scheduler.tick('manual')
      },
      quit: () => {
        markQuitting(mainWindow)
        markQuitting(widgetWindow)
        app.quit()
      }
    })
    tray.create()

    mainWindow = createMainWindow()
    attachMainWindowHooks(mainWindow)
    maybeScheduleScreenshot(mainWindow)

    syncWidgetWindow()

    // 端到端同步探针（TODO_E2E_SYNC=1 时才生效，平时零开销）
    maybeRunE2eSync()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow()
        attachMainWindowHooks(mainWindow)
      }
    })
  })

  app.on('window-all-closed', () => {
    // 注意：closeToTray 为 true 时窗口只是 hide，根本不会走到这里；
    // 走到这里说明用户的意图就是退出（或把 closeToTray 关了）
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    try {
      markQuitting(mainWindow)
      markQuitting(widgetWindow)
      appContext?.scheduler.stop()
      windowsNotifier?.disposeAll()
      tray?.destroy()
      appContext?.db.close()
    } catch {
      // 退出阶段清理失败不阻塞退出流程
    }
  })
}
