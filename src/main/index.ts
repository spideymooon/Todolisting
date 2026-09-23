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
import { applyWidgetResizable, createWidgetWindow, widgetResizeLock } from './widgets/widget.window'
import { seedSampleData } from './seed'
import { registerIpc } from './ipc/register-ipc'
import { createMainWindow } from './windows/main-window'
import { maybeScheduleScreenshot } from './dev/screenshot'
import { maybeRunE2eSync } from './dev/e2e-sync'
import type { AppContext } from './ipc/context'
import { IPC, clampWidgetSize, type AppSettings, type NotifyChannel, type WidgetStatus } from '@shared/types'

let mainWindow: BrowserWindow | null = null
let widgetWindow: BrowserWindow | null = null
let appContext: AppContext | null = null
let windowsNotifier: WindowsNotifier | null = null
let pushplusNotifier: PushPlusNotifier | null = null
let tray: TrayService | null = null

/**
 * Windows 的 toast 通知需要 AppUserModelID 才能被系统正确识别与归组；
 * 任务栏图标也按 AUMID 分组取图（AUMID 注册的快捷方式 → exe 内嵌图标）。
 *
 * ⚠ setAppUserModelId 必须**在 ready 之前**调用。
 * 之前把它放在 whenReady 回调里（或紧邻的顶层 if），在部分机器上会出现
 * 进程首帧的 AUMID 尚未生效、任务栏已经按旧的空 AUMID 取了通用图标，
 * 之后再改也不会重取 —— 这是「同一份安装包，换台电脑就白板」的直接原因。
 * Electron 官方要求也在 ready 之前设。
 *
 * 快捷方式的 AUMID 补写放在 ready 之后：那时 app.getPath() 语义最稳，
 * 且不影响进程启动。安装器创建的快捷方式不带 AUMID（见 dev-shortcut.ts），
 * 必须由应用自己补写（幂等，每次启动都跑，覆盖任务栏固定区）。
 */
app.setAppUserModelId(APP_USER_MODEL_ID)

if (!app.isPackaged) {
  // 开发态跑在 electron.exe 上，需要额外在开始菜单注册带 AUMID 的快捷方式
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
      },
      (w, h) => {
        // 尺寸记忆：与位置同理，'resized' 已保证只在结束时触发一次
        void appContext?.settings.set({ widgetW: w, widgetH: h })
      }
    )
    // 窗口刚建好，把缩放可用性告诉渲染层（手柄的禁用态靠这条消息对齐）
    notifyWidgetResizeState()
    return
  }

  // 已存在 → 同步置顶、缩放可用性与可见性
  widgetWindow.setAlwaysOnTop(settings.widgetAlwaysOnTop)
  // 需求核心：置顶即锁定缩放，取消置顶即恢复
  applyWidgetResizable(widgetWindow, settings.widgetAlwaysOnTop)
  if (!widgetWindow.isVisible()) widgetWindow.showInactive()
  notifyWidgetResizeState()
}

/**
 * 把小组件的尺寸改成某个值（设置页的预置档位走这条路）。
 *
 * 两个细节：
 *  1. 缩放被锁定（置顶）时**直接拒绝**，返回当前实际尺寸 —— 设置页与小组件
 *     都不该在锁定期还能改变大小，否则「锁定」就是假的
 *  2. 改完要把新尺寸同步给设置记忆：否则用户下次拖手柄时，
 *     'resized' 事件里对比的基准是旧值
 */
function setWidgetSize(w: number, h: number): void {
  const settings = appContext?.settings.all()
  if (!settings) return
  // 判据只认窗口自己的状态，不认设置值 —— 探针实测过：'resizable: false' 是窗口
  // **不可变属性**，置顶期间 setResizable(true) 改不动它；此时若按设置值放行，
  // 就会写进一个窗口实际达不到的尺寸，用户下次启动才发现不对
  if (!widgetWindow || widgetWindow.isDestroyed() || !widgetWindow.isResizable()) {
    notifyWidgetResizeState()
    return
  }
  const size = clampWidgetSize(w, h)
  // clampWidgetSize 已保证落在 [240..900]×[280..1000]，与 setMinimumSize/setMaximumSize
  // 是同一组常量，不会被窗口的最小/最大尺寸顶回来
  widgetWindow.setSize(size.w, size.h)
  void appContext?.settings.set({ widgetW: size.w, widgetH: size.h })
  notifyWidgetResizeState()
}

/**
 * 把缩放可用性广播给小组件渲染层（置顶时手柄要变成禁用态）。
 *
 * ⚠ 报给渲染层的是**窗口的真实能力**（isResizable()），不是设置值：
 * 探针实测发现 Windows 上 `resizable: false` 出生（或曾置顶过一次）的 frameless
 * 窗口，`setResizable(true)` 不会真的把它变回可缩放。如果这里按设置值上报，
 * 渲染层会显示一个能拖、但拖了没反应的手柄 —— 用户根本不知道发生了什么。
 * 报真话，手柄就会老老实实显示成锁定态并把原因写在提示里。
 */
function notifyWidgetResizeState(): void {
  if (!widgetWindow || widgetWindow.isDestroyed()) return
  const settings = appContext?.settings.all()
  const lockedBy = widgetResizeLock(settings?.widgetAlwaysOnTop ?? false)
  const realResizable = widgetWindow.isResizable()
  if (!realResizable) {
    console.warn(
      `[widget] 窗口实际不可缩放（设置锁定=${lockedBy ?? '无'}）—— 手柄将显示为禁用态`
    )
  }
  widgetWindow.webContents.send(IPC.widgetResizeState, {
    resizable: realResizable,
    lockedBy: realResizable ? null : (lockedBy ?? 'alwaysOnTop')
  })
}

function widgetStatus(): WidgetStatus {
  const settings = appContext?.settings.all()
  const alive = !!widgetWindow && !widgetWindow.isDestroyed()
  // 同样报窗口的真实能力，而不是设置值
  const realResizable = alive ? widgetWindow!.isResizable() : false
  const realSize = alive ? widgetWindow!.getSize() : null
  const lockedBy = widgetResizeLock(settings?.widgetAlwaysOnTop ?? false)
  const remembered = clampWidgetSize(settings?.widgetW ?? 300, settings?.widgetH ?? 420)
  return {
    enabled: settings?.widgetEnabled ?? false,
    visible: alive && widgetWindow!.isVisible(),
    alwaysOnTop: settings?.widgetAlwaysOnTop ?? false,
    resizable: realResizable,
    resizeLockedBy: realResizable ? null : (lockedBy ?? 'alwaysOnTop'),
    // 尺寸以窗口实际值为准（窗口没开时回落到记忆值）
    width: realSize ? realSize[0] : remembered.w,
    height: realSize ? realSize[1] : remembered.h
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
    setWidgetSize,
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
    // 打包态：补写所有已知位置快捷方式的 AUMID（含任务栏固定区）。
    // 放在 ready 之后是因为 app.getPath('desktop') 在 ready 前不保证可靠；
    // 幂等，重复执行无害。失败只影响任务栏图标，绝不能挡启动。
    if (app.isPackaged) {
      try {
        ensureInstalledShortcutAumid()
      } catch (err) {
        console.error('[aumid] 快捷方式补写失败（仅影响任务栏图标）', err)
      }
    }

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

    // 托盘先于窗口创建：关窗拦截依赖托盘存在（否则隐藏后用户没有入口找回来）。
    // v1.5.1 教训：托盘抛错曾中断整个启动回调，连主窗口都没创建、进程在后台空转
    // —— 托盘失败必须被隔离，没有托盘只是不能常驻，没有窗口应用就废了。
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
    try {
      tray.create()
    } catch (err) {
      console.error('[tray] 托盘创建失败（应用继续启动，仅无托盘）', err)
    }

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
