/** 主进程与渲染进程共用的领域类型与 IPC 契约常量 */

import type { RepeatRule } from './repeat'

export type { RepeatRule }

export type TaskStatus = 'pending' | 'completed'
export type Priority = 1 | 2 | 3
export type TagColor = 'red' | 'green' | 'blue' | 'amber' | 'purple' | 'gray'

/** 看板三列。不是新概念，是 tasks 表三个字段的查询视图 */
export type BoardColumn = 'pool' | 'todayPending' | 'todayDone'
export type MoveTarget = BoardColumn

/** 通知通道。`none` 表示两个通道都关，等价于不提醒（《00-架构设计》§4.1 短路守卫） */
export type NotifyChannel = 'none' | 'desktop' | 'wechat' | 'both'

/** 提醒日志的两类：正常提醒 / 逾期补提醒 */
export type ReminderType = 'reminder' | 'overdue'

/**
 * 提醒日志状态机：
 *   planned   已排期，未发送（scheduler 的唯一取数条件）
 *   sent      发送成功（终态）
 *   failed    发送尝试过但失败（终态，不自动重试，避免失败风暴；Phase 3 提供手动重发）
 *   skipped   从未发送但计划作废（进程崩溃中断）—— 允许复活重排
 *   cancelled 计划被 replan 作废（改了截止日期/提前天数/完成/删除）—— 允许复活重排
 *
 * 关键区别：failed 是「试过了」，skipped/cancelled 是「没试过」。
 * 只有「没试过」的才允许重新排期，这样既满足 §19「允许后续重新发送」，
 * 又不会让一个持续失败的任务每 30 秒重试一次。
 */
export type NotificationStatus = 'planned' | 'sent' | 'failed' | 'skipped' | 'cancelled'

/** 逾期策略：逾期后补提醒一次 / 完全不提醒 */
export type OverduePolicy = 'once' | 'never'

export interface Tag {
  id: string
  name: string
  color: TagColor
}

export interface Task {
  id: string
  title: string
  note: string | null
  status: TaskStatus
  priority: Priority
  /** 本地日历日 `YYYY-MM-DD` */
  dueDate: string | null
  /** `HH:mm` */
  dueTime: string | null
  /** 冗余 UTC 时刻，供排序与跨端比较 */
  dueAtUtc: string | null
  /** 是否开启提醒。硬开关，默认取新建时的全局默认值 */
  reminderEnabled: boolean
  /** 提前多少天提醒。0 = 当天提醒 */
  reminderDays: number
  /** 提醒时刻 `HH:mm`（本地时区） */
  reminderTime: string
  /** 该任务走哪些通道 */
  notifyChannels: NotifyChannel
  /**
   * 重复规则。null = 不重复。
   *
   * 语义是「**这条实例完成后**按什么规则续下一实例」—— 所以它挂在**当前活跃实例**上，
   * 而不是某个独立的规则表里（《TodoList-重复任务功能》§6：规则 + 当前实例，
   * 绝不预生成未来任务）。历史已完成实例身上仍留着当时的规则，供「已完成」页回显。
   */
  repeatRule: RepeatRule | null
  /**
   * 同一条重复规则的实例串联 id。
   * 首个实例写入自身 id，后续实例继承同一个值；非重复任务为 null。
   * 生成下一实例前用它做幂等判断（series_id + due_date 是否已存在）。
   */
  seriesId: string | null
  completedAt: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  tags: Tag[]
}

export interface BoardData {
  pool: Task[]
  /** 含逾期任务（浮在顶部） */
  todayPending: Task[]
  todayDone: Task[]
  todayKey: string
}

export interface CaptureResult {
  ok: boolean
  task?: Task
  error?: string
}

export interface CreateTaskInput {
  title: string
  note?: string | null
  priority?: Priority
  dueDate?: string | null
  dueTime?: string | null
  tags?: string[]
  reminderEnabled?: boolean
  reminderDays?: number
  reminderTime?: string
  notifyChannels?: NotifyChannel
  /** 重复规则。null / 不传 = 不重复。见 @shared/repeat 的 normalizeRule */
  repeatRule?: RepeatRule | null
}

export interface TaskPatch {
  title?: string
  note?: string | null
  priority?: Priority
  dueDate?: string | null
  dueTime?: string | null
  tags?: string[]
  reminderEnabled?: boolean
  reminderDays?: number
  reminderTime?: string
  notifyChannels?: NotifyChannel
  /**
   * 重复规则。null = 改为不重复。
   *
   * §10：第一版默认「修改当前实例及后续重复规则」—— 改规则只影响当前活跃实例与
   * 它之后生成的实例，**不改动历史已完成记录**（那些实例身上留着当时的规则快照）。
   */
  repeatRule?: RepeatRule | null
}

export interface CategorySummary {
  todayCount: number
  overdueCount: number
  boardCount: number
  upcomingCount: number
  allCount: number
  completedCount: number
}

export interface NotificationLog {
  id: string
  taskId: string
  /** 冗余任务标题，任务被删除后日志仍可读 */
  taskTitle: string
  type: ReminderType
  /** 计划执行时刻（UTC ISO）。catch-up 情形下是「现在 + 30s」 */
  scheduledAt: string
  /** `taskId|type|意图时刻` —— UNIQUE，防重复的物理防线 */
  planKey: string
  channel: NotifyChannel
  status: NotificationStatus
  error: string | null
  sentAt: string | null
  createdAt: string
}

/** 调度器健康状态，供设置页显示「提醒引擎正在运行」 */
export interface SchedulerStatus {
  running: boolean
  lastTickAt: string | null
  pendingCount: number
  /** 下一次将要触发的提醒 */
  nextDueAt: string | null
  nextDueTitle: string | null
}

/** 单通道的发送结果 */
export interface NotifyResult {
  ok: boolean
  error?: string
}

/** 设置页的「发送测试通知」：按通道返回结果 */
export interface TestNotifyResult {
  desktop?: NotifyResult
  wechat?: NotifyResult
}

/** PushPlus 连通性自检结果（设置页「测试连接」用） */
export interface PushPlusCheck {
  ok: boolean
  error?: string
}

/** 小组件运行状态，供设置页显示 */
export interface WidgetStatus {
  /** 是否已开启（设置项） */
  enabled: boolean
  /** 窗口当前是否真的开着 */
  visible: boolean
  alwaysOnTop: boolean
}

/** 无边框主窗口的窗口状态（自绘标题栏按钮图标用） */
export interface WindowState {
  maximized: boolean
}

/** 一次调度 tick 的结果 */
export interface DispatchResult {
  due: number
  sent: number
  failed: number
  cancelled: number
  /** 因重入保护被跳过的条数。正常应恒为 0，非 0 说明 tick 重叠过 */
  reentrant: number
}

/**
 * 小组件显示内容的取数范围。
 *
 * 取值与 ListScope 对齐（见 @shared/api）—— 小组件设置页就是让用户
 * 在这几个「页面视图」里挑一个挂到桌面上：
 *   today     今天页：逾期 + 今天
 *   upcoming  即将到期页：今天之后
 *   window    最近三天（旧版小组件的固定行为，保留作为可选项）
 *   all       全部任务：所有未完成任务（含无日期的）—— **默认值**
 *   completed 已完成页
 */
export type WidgetScope = 'today' | 'upcoming' | 'window' | 'all' | 'completed'

export interface AppSettings {
  captureDefaultTarget: 'today' | 'pool'
  theme: 'light' | 'dark' | 'system'
  /** §7 桌面提醒总开关 */
  desktopNotifyEnabled: boolean
  /** §7 微信提醒总开关（Phase 3 接通 PushPlus） */
  wechatNotifyEnabled: boolean
  /** 新建任务时提醒的初始值 —— 是「初始值」不是「继承源」，见下方说明 */
  defaultReminderEnabled: boolean
  defaultReminderDays: number
  defaultReminderTime: string
  overduePolicy: OverduePolicy

  // ── Phase 3：常驻与桌面小组件 ──
  /** 点关闭按钮时隐藏到托盘而不是退出。关掉它 = 回到「关窗即退出」 */
  closeToTray: boolean
  /** 随系统启动（静默，不显示窗口） */
  launchAtLogin: boolean
  /** 小组件总开关 */
  widgetEnabled: boolean
  /** 小组件是否置顶。默认关 —— 不是所有人都想让它盖在别的窗口上 */
  widgetAlwaysOnTop: boolean
  /** 小组件位置记忆。null = 用默认位置（右下角） */
  widgetX: number | null
  widgetY: number | null
  /** 小组件背景不透明度（0-100，百分比）。默认 86 —— 全透明看不清，不透明又太实 */
  widgetOpacity: number
  /**
   * 小组件显示内容的取数范围。默认 'all'（显示所有未完成任务），
   * 可在主窗口「小组件」设置页切换。见 WidgetScope 注释
   */
  widgetScope: WidgetScope

  // ── Phase 4：PushPlus ──
  /** PushPlus token。属敏感凭据，只存本地 SQLite，不出现在日志里 */
  pushplusToken: string
  /** 群组编码（一对多推送用）。留空 = 一对一推送给自己 */
  pushplusTopic: string
}

/**
 * 关于「全局默认」的语义（实现期明确的一个需求空白）：
 *
 * §7 说「全局默认设置 + 单个任务覆盖默认设置」，但在实现上有两种截然不同的做法：
 *   A. 继承：任务存 null 表示「跟随全局」，改全局 → 所有跟随的任务立刻重排提醒
 *   B. 快照：新建任务时把全局默认值**写死**进任务，改全局只影响以后新建的
 *
 * 这里选 B。理由：A 会让「我改一下默认提前天数」这一个动作，静默重排全库历史任务的
 * 提醒计划 —— 用户完全无法预期哪些任务被改了。B 的代价是「改了默认对老任务不生效」，
 * 但这个行为是**可解释**的，设置页也写明了。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  captureDefaultTarget: 'today',
  theme: 'system',
  desktopNotifyEnabled: true,
  wechatNotifyEnabled: false,
  defaultReminderEnabled: true,
  defaultReminderDays: 1,
  defaultReminderTime: '09:00',
  overduePolicy: 'once',

  closeToTray: true,
  launchAtLogin: false,
  widgetEnabled: false,
  widgetAlwaysOnTop: false,
  widgetX: null,
  widgetY: null,
  widgetOpacity: 86,
  widgetScope: 'all',

  pushplusToken: '',
  pushplusTopic: ''
}

/** §4 给出的可选提前天数。用户可以填自定义值，这里只是设置的快捷项 */
export const REMINDER_DAY_PRESETS = [0, 1, 2, 3, 7] as const

/** IPC 通道名集中在此，主进程与 preload 都从这里引，避免拼错 */
export const IPC = {
  board: 'task:board',
  list: 'task:list',
  /** 全局搜索：标题 + 备注 LIKE 匹配（工具栏搜索入口） */
  search: 'task:search',
  capture: 'task:capture',
  /** 编辑器「新建任务」：带完整字段的创建（与 capture 的原始文本入口相对） */
  create: 'task:create',
  toggle: 'task:toggle',
  moveTask: 'task:moveTask',
  update: 'task:update',
  remove: 'task:remove',
  tags: 'tag:list',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  counts: 'task:counts',
  revealDb: 'system:revealDb',
  dbPath: 'system:dbPath',
  /** 弹目录选择框，把 SQLite 文件迁移过去，成功后应用自动重启 */
  changeDbDir: 'system:changeDbDir',
  tasksChanged: 'tasks:changed',
  captureFocus: 'capture:focus',
  /** 通知：状态查询 / 日志 / 立即检查 / 测试通知 / 手动重发 */
  notifyTick: 'notify:tick',
  notifyLogs: 'notify:logs',
  notifyStatus: 'notify:status',
  notifyTest: 'notify:test',
  notifyRetry: 'notify:retry',
  /** 主进程 → 渲染层：点击通知后定位到任务 */
  locateTask: 'task:locate',

  // ── 无边框主窗口（《UI优化》§8–§10）──
  /** 自绘标题栏的窗口控制 */
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  /** 主进程 → 渲染层：最大化状态变化（切换按钮图标） */
  windowState: 'window:state',

  // ── Phase 3：桌面小组件 ──
  /** 小组件开关 / 置顶 / 位置记忆 / 状态查询 */
  widgetStatus: 'widget:status',
  widgetSetEnabled: 'widget:setEnabled',
  widgetSetAlwaysOnTop: 'widget:setAlwaysOnTop',
  /** 小组件窗口 → 主进程：报告新位置以便记忆 */
  widgetMoved: 'widget:moved',
  /** 主进程 → 小组件：数据变化的刷新信号（复用全窗口广播） */
  widgetOpenMain: 'widget:openMain',

  // ── Phase 4：PushPlus ──
  /** 验证 token 是否可用（只发一条通道自检，不依赖任务） */
  pushplusCheck: 'pushplus:check'
} as const
