/**
 * 桌面小组件的独立 store。
 *
 * 刻意**不复用主窗口的 appStore** —— 两者职责不同：
 * 主窗口需要 page/editing/settings 等一堆状态，小组件只要一份「未来任务列表」。
 * 共用会让小组件为了一个列表把整个主窗口的状态机拖进来，也让两边互相污染。
 *
 * 但**创建逻辑必须共用**：捕获解析走 @shared/capture-parse，
 * 落库走同一个 IPC `task:capture` —— 这是 v0.3 定下的原则，不维护第二套。
 */

import { create } from 'zustand'
import type { CaptureTarget } from '@shared/capture-parse'
import type { AppSettings, Task, WidgetScope } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

/**
 * 合法取数范围白名单。settings 里存的值不可信（可能是旧版本写入或被手改），
 * 不在白名单里一律回落到 'all' —— 与 DEFAULT_SETTINGS.widgetScope 保持一致。
 */
const WIDGET_SCOPES: readonly WidgetScope[] = ['today', 'upcoming', 'window', 'all', 'completed']

export function widgetScopeOf(settings: AppSettings): WidgetScope {
  return WIDGET_SCOPES.includes(settings.widgetScope) ? settings.widgetScope : 'all'
}

/**
 * 显示页面的可选项。小组件左上角的切换菜单与主窗口「小组件」设置页共用这一份，
 * 顺序即菜单顺序：默认的「全部任务」放最前。
 */
export const WIDGET_SCOPE_OPTIONS: Array<{ value: WidgetScope; label: string }> = [
  { value: 'all', label: '全部任务' },
  { value: 'today', label: '今天' },
  { value: 'upcoming', label: '待办任务' },
  { value: 'window', label: '最近三天' },
  { value: 'completed', label: '已完成' }
]

interface WidgetState {
  tasks: Task[]
  settings: AppSettings
  ready: boolean
  /** 最近完成的任务 id，用于让勾选动画播完再消失 */
  justDoneId: string | null
  /**
   * 当前是否允许缩放。由主进程推送（widgetResizeState 广播 + 初始化查询），
   * **不在渲染层自己算** —— 置顶那一下是主进程 setResizable 关掉的，
   * 渲染层只需要照着显示。
   */
  resizable: boolean
  /** 缩放被锁定的原因；null = 未锁定。用于给出「取消置顶后可缩放」的提示文案 */
  resizeLockedBy: 'alwaysOnTop' | null
  /** 拖拽手柄期间置 true：临时关掉 -webkit-app-region，见 WidgetApp 的说明 */
  resizing: boolean

  load: () => Promise<void>
  refresh: () => Promise<void>
  toggle: (id: string) => Promise<void>
  capture: (raw: string, target: CaptureTarget) => Promise<boolean>
  /** 头部图钉开关：切小组件窗口的置顶（顺带锁定/解锁缩放） */
  setPinned: (on: boolean) => Promise<void>
  /** 头部 ✕：直接关掉小组件（写 widgetEnabled=false，主进程销毁窗口） */
  hide: () => Promise<void>
  /** 左上角菜单切换显示页面：落库 + 按新范围重新取数 */
  setScope: (scope: WidgetScope) => Promise<void>
  openMain: (taskId?: string) => Promise<void>
  clearJustDone: () => void
  /** 拖拽右下角手柄期间切换 */
  setResizing: (on: boolean) => void
  /** 拖动结束 → 上报新尺寸落库 */
  commitSize: () => Promise<void>
}

export const useWidgetStore = create<WidgetState>((set, get) => ({
  tasks: [],
  settings: DEFAULT_SETTINGS,
  ready: false,
  justDoneId: null,
  // 初值给 true 而不是 false：置顶状态要先问主进程才知道，若初值 false，
  // 非置顶用户的第一次渲染会看到一个闪一下的禁用手柄
  resizable: true,
  resizeLockedBy: null,
  resizing: false,

  load: async () => {
    // scope 跟随设置（默认 all = 所有未完成任务），所以必须先拿 settings 再取数
    const settings = await window.api.settings.get()
    const tasks = await window.api.task.list(widgetScopeOf(settings))
    // 缩放的初始可用性要问主进程：置顶状态可能来自设置页而不是小组件上的图钉
    const resize = await window.api.widget.resizeState()
    set({
      settings,
      tasks,
      ready: true,
      resizable: resize.resizable,
      resizeLockedBy: resize.lockedBy
    })
  },

  refresh: async () => {
    // settings 一起重取：置顶开关、显示范围在设置页也可能被改，任务广播顺带把
    // 图钉状态与取数范围对齐，两个入口永远以落库值为准。
    // 设置页改 widgetScope 时 settingsSet 末尾的 broadcastTasksChanged 会叫醒这里
    const settings = await window.api.settings.get()
    const tasks = await window.api.task.list(widgetScopeOf(settings))
    set({ settings, tasks })
  },

  toggle: async (id) => {
    // 先标记再刷新：让组件有机会播完「划线消失」的动画，而不是列表瞬间跳变
    set({ justDoneId: id })
    await window.api.task.toggle(id)
    // 给动画留出时间再拉新数据
    setTimeout(() => void get().refresh(), 260)
  },

  capture: async (raw, target) => {
    const result = await window.api.task.capture(raw, target)
    if (result.ok) {
      await get().refresh()
      return true
    }
    return false
  },

  setPinned: async (on) => {
    // 主进程会同时写设置 + setAlwaysOnTop + setResizable(!on)；返回值是落库后的真实状态，
    // 用它回填本地，避免「点了很多下之后图标状态与实际不一致」。
    // resizable 必须跟着回填：置顶锁定缩放这件事的真相在主进程
    const status = await window.api.widget.setAlwaysOnTop(on)
    set({
      settings: { ...get().settings, widgetAlwaysOnTop: status.alwaysOnTop },
      resizable: status.resizable,
      resizeLockedBy: status.resizeLockedBy
    })
  },

  hide: async () => {
    // settingsSet handler 里有 WIDGET_SETTING_KEYS 拦截：widgetEnabled 变更
    // 会触发 syncWidgetWindow()，把当前窗口销毁 —— 所以这里不用也不能自己 close
    await window.api.settings.set({ widgetEnabled: false })
  },

  setScope: async (scope) => {
    // 与设置页走同一条 settingsSet 路径：主进程广播 tasksChanged，
    // refresh() 会以新 scope 重新取数；这里再回填一次 settings 保证标题即时更新
    await window.api.settings.set({ widgetScope: scope })
    await get().refresh()
  },

  openMain: async (taskId) => {
    await window.api.widget.openMain(taskId ?? null)
  },

  clearJustDone: () => set({ justDoneId: null }),

  setResizing: (on) => set({ resizing: on }),

  commitSize: async () => {
    set({ resizing: false })
    // 不传渲染层量到的宽高：resizeTo 之后同步读 innerWidth 拿到的是**旧值**
    //（探针实测：拖到 520×540，同步读仍是 420×420，落库就被旧值覆盖了）。
    // 主进程在收到这条 IPC 时自己读窗口实际大小 —— 那时 resize 一定已经生效
    const status = await window.api.widget.resize()
    set({
      settings: { ...get().settings, widgetW: status.width, widgetH: status.height },
      resizable: status.resizable,
      resizeLockedBy: status.resizeLockedBy
    })
  }
}))
