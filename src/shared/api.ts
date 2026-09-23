/** preload 暴露给渲染层的白名单 API 的**类型契约**（纯类型，无运行时） */

import type { CaptureTarget } from './capture-parse'
import type {
  AppSettings,
  BoardData,
  CaptureResult,
  CategorySummary,
  CreateTaskInput,
  DispatchResult,
  MoveTarget,
  NotificationLog,
  PushPlusCheck,
  SchedulerStatus,
  Tag,
  Task,
  TaskPatch,
  TestNotifyResult,
  WidgetStatus,
  WindowResizedEvent,
  WindowState
} from './types'

/**
 * 列表作用域。
 *
 * `window` 是给桌面小组件用的：它要的是「逾期 + 今天 + 明天 + 后天」这一扇窗口
 * （§14.4），既不是 `today`（只看今天及更早），也不是 `upcoming`（只看今天之后）。
 * 独立成一个 scope 而不是在渲染层拉全量再过滤 —— 过滤放 SQL 里更省，
 * 也让「小组件到底在显示什么」这件事在主进程有唯一答案。
 */
export type ListScope = 'today' | 'upcoming' | 'window' | 'all' | 'completed'

export interface TodoApi {
  task: {
    board(): Promise<BoardData>
    list(scope: ListScope): Promise<Task[]>
    /** 全局搜索：标题 + 备注（工具栏放大镜入口） */
    search(query: string): Promise<Task[]>
    counts(): Promise<CategorySummary>
    /** 只传原始文本 + 默认落点，解析在主进程做 */
    capture(raw: string, target: CaptureTarget): Promise<CaptureResult>
    /** 编辑器「新建任务」：字段在编辑器里已由用户显式选定（日期选择器，不含自然语言），直接结构化传入 */
    create(input: CreateTaskInput): Promise<Task>
    toggle(id: string): Promise<Task | null>
    /** 看板拖拽的原子操作 */
    moveTask(id: string, target: MoveTarget): Promise<Task | null>
    update(id: string, patch: TaskPatch): Promise<Task | null>
    remove(id: string): Promise<boolean>
  }
  tags: {
    list(): Promise<Tag[]>
  }
  /** 无边框主窗口的自绘标题栏控制（《UI优化》§8–§10） */
  win: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<WindowState>
    /** 与系统关闭按钮同一条路径，会经过「关窗到托盘」拦截 */
    close(): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  notify: {
    /** 调度器 + 待发计划的状态 */
    status(): Promise<SchedulerStatus>
    /** 提醒日志（防重复的审计痕迹） */
    logs(limit?: number): Promise<NotificationLog[]>
    /** §6 的「发送测试通知」，桌面通道同样适用 */
    test(): Promise<TestNotifyResult>
    /** 立即跑一次调度，不等 30 秒 */
    tick(): Promise<{ status: SchedulerStatus; result: DispatchResult | null }>
    /** 手动重发一条失败的通知（§19） */
    retry(logId: string): Promise<boolean>
  }
  widget: {
    /** 小组件的开关 / 可见性 / 置顶 / 缩放可用性 / 当前尺寸 */
    status(): Promise<WidgetStatus>
    setEnabled(enabled: boolean): Promise<WidgetStatus>
    setAlwaysOnTop(on: boolean): Promise<WidgetStatus>
    /**
     * 小组件窗口拖动右下角手柄结束后提交尺寸。
     * **不要传渲染层量到的宽高**（innerWidth 在 resizeTo 后是旧值）——
     * 主进程自己读窗口实际大小落库。置顶（缩放被锁定）时直接忽略。
     */
    resize(): Promise<WidgetStatus>
    /** 按预置档位改尺寸（主窗口「小组件」页的尺寸分段控件） */
    setSize(w: number, h: number): Promise<WidgetStatus>
    /** 查询当前缩放可用性（小组件初始化手柄禁用态） */
    resizeState(): Promise<WindowResizedEvent>
    /** 小组件窗口点击任务时调用：显示主窗口并定位（taskId 为 null 则只显示） */
    openMain(taskId: string | null): Promise<void>
  }
  pushplus: {
    /** §6 的「测试连接」：验证 token 是否可用 */
    check(): Promise<PushPlusCheck>
  }
  system: {
    revealDb(): Promise<string>
    dbPath(): Promise<string>
    /**
     * 弹目录选择框并迁移数据库。ok=true 时应用会自动重启；
     * canceled=用户取消；error=迁移失败原因
     */
    changeDbDir(): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
  }
  on: {
    tasksChanged(cb: () => void): () => void
    captureFocus(cb: () => void): () => void
    /** 点击通知后主进程发来的任务定位请求（§5） */
    locateTask(cb: (taskId: string) => void): () => void
    /** 无边框窗口的最大化状态变化（自绘标题栏切换图标） */
    windowState(cb: (state: WindowState) => void): () => void
    /** 小组件缩放可用性变化（置顶时被锁定 → 手柄变禁用态） */
    widgetResizeState(cb: (state: WindowResizedEvent) => void): () => void
  }
}
