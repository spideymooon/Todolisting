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
import type { AppSettings, Task } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ListScope } from '@shared/api'

/**
 * 小组件取数用 `window` scope = 逾期 + 今天 + 明天 + 后天。
 *
 * 注意不要改成 `upcoming`：那个 scope 的 SQL 是 `due_date > today`，
 * 会把「今天」和「逾期」全部排除掉，小组件就永远是空的。
 */
const WIDGET_SCOPE: ListScope = 'window'

interface WidgetState {
  tasks: Task[]
  settings: AppSettings
  ready: boolean
  /** 最近完成的任务 id，用于让勾选动画播完再消失 */
  justDoneId: string | null

  load: () => Promise<void>
  refresh: () => Promise<void>
  toggle: (id: string) => Promise<void>
  capture: (raw: string, target: CaptureTarget) => Promise<boolean>
  /** 头部图钉开关：切小组件窗口的置顶 */
  setPinned: (on: boolean) => Promise<void>
  /** 头部 ✕：直接关掉小组件（写 widgetEnabled=false，主进程销毁窗口） */
  hide: () => Promise<void>
  openMain: (taskId?: string) => Promise<void>
  clearJustDone: () => void
}

export const useWidgetStore = create<WidgetState>((set, get) => ({
  tasks: [],
  settings: DEFAULT_SETTINGS,
  ready: false,
  justDoneId: null,

  load: async () => {
    const [settings, tasks] = await Promise.all([
      window.api.settings.get(),
      window.api.task.list(WIDGET_SCOPE)
    ])
    set({ settings, tasks, ready: true })
  },

  refresh: async () => {
    // settings 一起重取：置顶开关在设置页也可能被改，任务广播顺带把
    // 图钉状态对齐，两个入口永远以落库值为准
    const [settings, tasks] = await Promise.all([
      window.api.settings.get(),
      window.api.task.list(WIDGET_SCOPE)
    ])
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
    // 主进程会同时写设置 + setAlwaysOnTop；返回值是落库后的真实状态，
    // 用它回填本地，避免「点了很多下之后图标状态与实际不一致」
    const status = await window.api.widget.setAlwaysOnTop(on)
    set({ settings: { ...get().settings, widgetAlwaysOnTop: status.alwaysOnTop } })
  },

  hide: async () => {
    // settingsSet handler 里有 WIDGET_SETTING_KEYS 拦截：widgetEnabled 变更
    // 会触发 syncWidgetWindow()，把当前窗口销毁 —— 所以这里不用也不能自己 close
    await window.api.settings.set({ widgetEnabled: false })
  },

  openMain: async (taskId) => {
    await window.api.widget.openMain(taskId ?? null)
  },

  clearJustDone: () => set({ justDoneId: null })
}))
