import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/types'
import type { TodoApi, ListScope } from '@shared/api'
import type { CaptureTarget } from '@shared/capture-parse'
import type { AppSettings, CreateTaskInput, MoveTarget, TaskPatch, WindowResizedEvent, WindowState } from '@shared/types'

/**
 * 渲染层唯一的对外通道。
 * contextIsolation: true + nodeIntegration: false —— 渲染层拿不到 require / fs / child_process，
 * 只能调用下面这些明确列出的方法。
 */
const api: TodoApi = {
  task: {
    board: () => ipcRenderer.invoke(IPC.board),
    list: (scope: ListScope) => ipcRenderer.invoke(IPC.list, scope),
    search: (query: string) => ipcRenderer.invoke(IPC.search, query),
    counts: () => ipcRenderer.invoke(IPC.counts),
    capture: (raw: string, target: CaptureTarget) => ipcRenderer.invoke(IPC.capture, raw, target),
    create: (input: CreateTaskInput) => ipcRenderer.invoke(IPC.create, input),
    toggle: (id: string) => ipcRenderer.invoke(IPC.toggle, id),
    moveTask: (id: string, target: MoveTarget) => ipcRenderer.invoke(IPC.moveTask, id, target),
    update: (id: string, patch: TaskPatch) => ipcRenderer.invoke(IPC.update, id, patch),
    remove: (id: string) => ipcRenderer.invoke(IPC.remove, id)
  },
  tags: {
    list: () => ipcRenderer.invoke(IPC.tags)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  notify: {
    status: () => ipcRenderer.invoke(IPC.notifyStatus),
    logs: (limit?: number) => ipcRenderer.invoke(IPC.notifyLogs, limit),
    test: () => ipcRenderer.invoke(IPC.notifyTest),
    tick: () => ipcRenderer.invoke(IPC.notifyTick),
    retry: (logId: string) => ipcRenderer.invoke(IPC.notifyRetry, logId)
  },
  widget: {
    status: () => ipcRenderer.invoke(IPC.widgetStatus),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.widgetSetEnabled, enabled),
    setAlwaysOnTop: (on: boolean) => ipcRenderer.invoke(IPC.widgetSetAlwaysOnTop, on),
    /** 拖动右下角手柄结束后提交当前尺寸（主进程自己读窗口实际大小） */
    resize: () => ipcRenderer.invoke(IPC.widgetResized),
    /** 按预置档位改尺寸（主窗口设置页用） */
    setSize: (w: number, h: number) => ipcRenderer.invoke(IPC.widgetSetSize, w, h),
    /** 问一次当前能不能缩放（小组件初始化手柄禁用态） */
    resizeState: () => ipcRenderer.invoke(IPC.widgetResizeState),
    openMain: (taskId: string | null) => ipcRenderer.invoke(IPC.widgetOpenMain, taskId)
  },
  pushplus: {
    check: () => ipcRenderer.invoke(IPC.pushplusCheck)
  },
  system: {
    revealDb: () => ipcRenderer.invoke(IPC.revealDb),
    dbPath: () => ipcRenderer.invoke(IPC.dbPath),
    changeDbDir: () => ipcRenderer.invoke(IPC.changeDbDir)
  },
  win: {
    minimize: () => ipcRenderer.invoke(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(IPC.windowClose)
  },
  on: {
    tasksChanged: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.tasksChanged, listener)
      return () => {
        ipcRenderer.removeListener(IPC.tasksChanged, listener)
      }
    },
    captureFocus: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC.captureFocus, listener)
      return () => {
        ipcRenderer.removeListener(IPC.captureFocus, listener)
      }
    },
    locateTask: (cb: (taskId: string) => void) => {
      const listener = (_e: unknown, taskId: string): void => cb(taskId)
      ipcRenderer.on(IPC.locateTask, listener)
      return () => {
        ipcRenderer.removeListener(IPC.locateTask, listener)
      }
    },
    windowState: (cb: (state: WindowState) => void) => {
      const listener = (_e: unknown, state: WindowState): void => cb(state)
      ipcRenderer.on(IPC.windowState, listener)
      return () => {
        ipcRenderer.removeListener(IPC.windowState, listener)
      }
    },
    widgetResizeState: (cb: (state: WindowResizedEvent) => void) => {
      const listener = (_e: unknown, state: WindowResizedEvent): void => cb(state)
      ipcRenderer.on(IPC.widgetResizeState, listener)
      return () => {
        ipcRenderer.removeListener(IPC.widgetResizeState, listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
