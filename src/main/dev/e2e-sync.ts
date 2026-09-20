/**
 * 端到端同步探针（开发期诊断工具）。
 *
 * 设 `TODO_E2E_SYNC=1` 时启用：等两个窗口就绪后，从**小组件窗口**的渲染上下文
 * 真实执行 capture → toggle → remove（与用户点击小组件完全同一条 IPC 链路），
 * 每一步检查**主窗口 DOM** 里探针任务的位置，回答一个问题：
 *
 *   「小组件里改了任务，主窗口到底同步没有？」
 *
 * 探针任务标题带 __e2e_sync_probe__ 标记，用完即删，不污染用户数据。
 * 结论输出到 stdout；同时存两张截图到 docs/e2e-sync-*.png 作为凭证。
 * 不设环境变量时本文件完全不生效。
 */

import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROBE = '__e2e_sync_probe__'
const STEP_MS = 900

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 在窗口渲染上下文里执行 JS（awaitPromise），窗口没了就抛错 */
async function evalIn(win: BrowserWindow | null | undefined, expr: string): Promise<unknown> {
  if (!win || win.isDestroyed()) throw new Error('目标窗口不存在')
  return win.webContents.executeJavaScript(expr, true)
}

/** 主窗口 DOM 探针：标题出现在「今日已完成」之后即为已同步 */
const PROBE_STATE_JS = `(async () => {
  const text = document.body.innerText
  const idx = text.indexOf('${PROBE}')
  const doneIdx = text.indexOf('今日已完成')
  return { present: idx >= 0, inDone: idx >= 0 && doneIdx >= 0 && idx > doneIdx }
})()`

function pickWindows(): { main: BrowserWindow | null; widget: BrowserWindow | null } {
  let main: BrowserWindow | null = null
  let widget: BrowserWindow | null = null
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    if (w.getBounds().width < 500 && !widget) widget = w
    else if (!main) main = w
  }
  return { main, widget }
}

async function screenshotAll(): Promise<void> {
  const dir = join(app.getAppPath(), 'docs')
  mkdirSync(dir, { recursive: true })
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    const image = await w.webContents.capturePage()
    if (image.isEmpty()) continue
    const suffix = w.getBounds().width < 500 ? '-widget.png' : '.png'
    const path = join(dir, `e2e-sync${suffix}`)
    writeFileSync(path, image.toPNG())
    console.log(`[e2e-sync] 截图 ${path}`)
  }
}

export function maybeRunE2eSync(flag = process.env.TODO_E2E_SYNC): void {
  if (!flag) return

  void (async () => {
    try {
      await sleep(2500) // 等主窗口 + 小组件都完成加载与首次取数
      const { main, widget } = pickWindows()
      if (!main) throw new Error('找不到主窗口')
      console.log(`[e2e-sync] 窗口：主=${!!main} 小组件=${!!widget}`)

      // 动作执行者：优先小组件（复刻用户操作），没有就用主窗口兜底
      const actor = widget ?? main
      const act = (expr: string): Promise<unknown> => evalIn(actor, expr)
      const probe = (expr: string): Promise<unknown> => evalIn(main, expr)

      // 1. 从小组件创建探针任务（走真实 capture IPC）
      const created = (await act(`(async () => {
        const r = await window.api.task.capture('${PROBE}', 'today')
        return r && r.ok ? r.task.id : null
      })()`)) as string | null
      console.log(`[e2e-sync] 探针任务: ${created ?? '创建失败'}`)

      try {
        if (created) {
          await sleep(STEP_MS)
          const before = (await probe(PROBE_STATE_JS)) as { present: boolean; inDone: boolean }
          console.log(`[e2e-sync] 勾选前 主窗口: ${JSON.stringify(before)}`)

          // 2. 从小组件勾选完成（与用户点击复选框同一条 IPC）
          await act(`window.api.task.toggle('${created}')`)
          await sleep(STEP_MS + 600)
          const after = (await probe(PROBE_STATE_JS)) as { present: boolean; inDone: boolean }
          console.log(`[e2e-sync] 勾选后 主窗口: ${JSON.stringify(after)}`)
          console.log(`[e2e-sync] >>> 主窗口同步: ${after.inDone ? 'YES ✓' : 'NO ✗'}`)
        } else {
          console.log('[e2e-sync] >>> 主窗口同步: UNKNOWN（探针创建失败）')
        }
      } finally {
        // 3. 清理探针（无论结论如何都不留垃圾）
        if (created) {
          await act(`window.api.task.remove('${created}')`).catch(() => undefined)
          await sleep(STEP_MS)
          const cleaned = (await probe(PROBE_STATE_JS).catch(() => null)) as {
            present: boolean
          } | null
          console.log(`[e2e-sync] 清理后 主窗口: ${JSON.stringify(cleaned)}`)
        }
        await screenshotAll()
      }
    } catch (err) {
      console.error('[e2e-sync] 失败', err)
    } finally {
      app.quit()
    }
  })()
}
