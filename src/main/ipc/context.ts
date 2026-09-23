import type { Db } from '../core/database/connection'
import type { SettingsService } from '../services/config/settings.service'
import type { TaskService } from '../core/task/task.service'
import type { NotificationService } from '../core/notification/notification.service'
import type { SchedulerService } from '../services/notification/scheduler.service'
import type { PushPlusCheck, WidgetStatus } from '@shared/types'

/** 主进程各层的装配结果，由 index.ts 组装后交给 ipc 层使用 */
export interface AppContext {
  db: Db
  dbPath: string
  tasks: TaskService
  settings: SettingsService
  notifications: NotificationService
  scheduler: SchedulerService
  /** 任何写操作成功后调用，向所有窗口广播 tasks:changed */
  broadcastTasksChanged: () => void
  /**
   * 打开主窗口并让渲染层定位到某个任务（点击通知 / 小组件任务时调用，§5）。
   * 传 null 表示只显示窗口、不定位 —— 托盘「显示主窗口」用的就是它。
   */
  openAndLocate: (taskId: string | null) => void

  /** 小组件状态（开关 / 可见性 / 置顶 / 缩放可用性 / 尺寸） */
  widgetStatus: () => WidgetStatus
  /** 设置变更后重建或销毁小组件窗口，并同步置顶、缩放可用性与可见性 */
  syncWidgetWindow: () => void
  /**
   * 把小组件尺寸改成指定值（设置页的预置档位）。
   * 缩放被锁定（置顶）时静默忽略 —— 锁定的语义由主进程说了算。
   */
  setWidgetSize: (w: number, h: number) => void
  /** PushPlus 通道自检（设置页「测试连接」） */
  pushplusCheck: () => Promise<PushPlusCheck>
}
