/**
 * 开发期截图工具。
 *
 * 设了环境变量 `TODO_SCREENSHOT=<png路径>` 时，窗口加载完成后把渲染结果截图存盘并退出。
 * 用途：在没有 GUI 交互能力的自动化环境里验证界面真实渲染效果（而不是靠脑补）。
 *
 * Phase 3 起支持多窗口：主窗口存到目标路径，其余窗口（桌面小组件）存到
 * `<同名>-widget.png` —— 小组件是独立 BrowserWindow，不拍它就等于没验证。
 *
 * 不设这个变量时本文件完全不生效，不影响正常运行。
 */

import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function maybeScheduleScreenshot(win: BrowserWindow, target = process.env.TODO_SCREENSHOT): void {
  if (!target) return

  const delay = Number(process.env.TODO_SCREENSHOT_DELAY ?? '2200')

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        try {
          for (const w of BrowserWindow.getAllWindows()) {
            if (w.isDestroyed() || !w.isVisible()) continue
            const image = await w.webContents.capturePage()
            if (image.isEmpty()) continue
            // 小组件窗口宽 300，主窗口最小 760 —— 用宽度区分
            const isWidget = w.getBounds().width < 500
            const path = isWidget ? target.replace(/\.png$/, '-widget.png') : target
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, image.toPNG())
            console.log(`[screenshot] 已保存 ${path} (${image.getSize().width}x${image.getSize().height})`)
          }
        } catch (err) {
          console.error('[screenshot] 失败', err)
        } finally {
          app.quit()
        }
      })()
    }, delay)
  })
}
