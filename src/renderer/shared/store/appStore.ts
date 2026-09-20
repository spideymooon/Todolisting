import { create } from 'zustand'
import type { CaptureTarget } from '@shared/capture-parse'
import type {
  AppSettings,
  BoardData,
  CaptureResult,
  CategorySummary,
  CreateTaskInput,
  MoveTarget,
  Priority,
  Task,
  TaskPatch
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export type PageKey =
  | 'today'
  | 'board'
  | 'upcoming'
  | 'all'
  | 'completed'
  | 'search'
  | 'widget'
  | 'settings'

interface AppState {
  page: PageKey
  board: BoardData | null
  counts: CategorySummary | null
  settings: AppSettings
  ready: boolean
  /** 每次 refresh 自增。列表页把它当依赖，就能在任意写操作后自动重新拉取 */
  revision: number
  /** 最近一次通过捕获条创建的任务 id，用于让它高亮 800ms */
  lastCreatedId: string | null
  /** 递增即请求把焦点放进捕获条 */
  focusNonce: number
  /** 正在编辑的任务。存整个对象而不是 id —— 已完成页的任务不在 board 里，查不到 */
  editing: Task | null
  /** 编辑器处于「新建任务」模式（editing 为 null 且 creating 为 true） */
  creating: boolean
  /** 点击通知后要滚动定位并高亮的任务 id（§5） */
  locateId: string | null
  locateNonce: number
  error: string | null
  /** 左侧 Sidebar 是否展开（标题栏第一个按钮控制）。收起时内容区自动扩展 */
  sidebarOpen: boolean

  setPage: (page: PageKey) => void
  toggleSidebar: () => void
  refresh: () => Promise<void>
  capture: (raw: string, target: CaptureTarget) => Promise<CaptureResult>
  createTask: (input: CreateTaskInput) => Promise<Task | null>
  toggle: (id: string) => Promise<void>
  move: (id: string, target: MoveTarget) => Promise<void>
  remove: (id: string) => Promise<void>
  setPriority: (id: string, priority: Priority) => Promise<void>
  updateTask: (id: string, patch: TaskPatch) => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  requestCaptureFocus: () => void
  clearFlash: () => void

  openEditor: (task: Task) => void
  openCreator: () => void
  closeEditor: () => void
  /** 打开「全部任务」页并定位到该任务 */
  locate: (taskId: string) => void
  clearLocate: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  page: 'board',
  board: null,
  counts: null,
  settings: DEFAULT_SETTINGS,
  ready: false,
  revision: 0,
  lastCreatedId: null,
  focusNonce: 0,
  editing: null,
  creating: false,
  locateId: null,
  locateNonce: 0,
  error: null,
  sidebarOpen: true,

  setPage: (page) => set({ page }),

  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),

  refresh: async () => {
    try {
      const [board, counts] = await Promise.all([
        window.api.task.board(),
        window.api.task.counts()
      ])
      set({ board, counts, ready: true, error: null, revision: get().revision + 1 })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  capture: async (raw, target) => {
    const result = await window.api.task.capture(raw, target)
    if (result.ok && result.task) {
      set({ lastCreatedId: result.task.id })
      await get().refresh()
    } else {
      set({ error: result.error ?? '保存失败' })
    }
    return result
  },

  createTask: async (input) => {
    try {
      const task = await window.api.task.create(input)
      set({ lastCreatedId: task.id, error: null })
      await get().refresh()
      return task
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  toggle: async (id) => {
    await window.api.task.toggle(id)
    await get().refresh()
  },

  move: async (id, target) => {
    await window.api.task.moveTask(id, target)
    await get().refresh()
  },

  remove: async (id) => {
    await window.api.task.remove(id)
    // 删掉的正是在编辑器里打开的这条 → 直接关掉，否则会编辑一个已经不存在的任务
    if (get().editing?.id === id) set({ editing: null })
    await get().refresh()
  },

  setPriority: async (id, priority) => {
    await window.api.task.update(id, { priority })
    await get().refresh()
  },

  updateTask: async (id, patch) => {
    await window.api.task.update(id, patch)
    await get().refresh()
  },

  updateSettings: async (patch) => {
    const settings = await window.api.settings.set(patch)
    set({ settings })
    // 通知类设置变更会在主进程侧触发全量重排，这里刷新一次让界面上的提醒标记同步
    await get().refresh()
  },

  requestCaptureFocus: () => set({ focusNonce: get().focusNonce + 1 }),

  clearFlash: () => set({ lastCreatedId: null }),

  openEditor: (task) => set({ editing: task, creating: false }),

  openCreator: () => set({ creating: true, editing: null }),

  closeEditor: () => set({ editing: null, creating: false }),

  locate: (taskId) =>
    set({
      page: 'all',
      locateId: taskId,
      locateNonce: get().locateNonce + 1,
      editing: null,
      creating: false
    }),

  clearLocate: () => set({ locateId: null })
}))

/** 从 board 里找出所有任务，供「全部任务」「已完成」这类聚合视图复用本地缓存 */
export function flattenBoard(board: BoardData | null): Task[] {
  if (!board) return []
  return [...board.todayPending, ...board.todayDone, ...board.pool]
}
