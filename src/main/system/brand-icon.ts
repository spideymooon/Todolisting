/**
 * 品牌图标的**运行时**定位。
 *
 * 历史教训（v1.5.1 安装版三连坑，务必记住）：
 * electron-vite 的 `?asset` 在**构建期**把路径写死成
 * `path.join(__dirname, "../../resources/x.png")`：
 *   - dev 下 `__dirname` = `out/main`，`../..` 解析到项目根 resources/（存在，一切正常）
 *   - 打包后 `__dirname` = `<安装目录>\resources\app.asar\out\main`，`../..` 指向
 *     app.asar **内部**的 resources/（不存在）→ readFileSync 抛 ENOENT
 *     → 托盘创建炸掉，并连累同回调里的主窗口创建 —— 进程在后台空转、
 *       无托盘、无窗口、任务栏无图标（用户实测三连报）。
 *
 * 所以图标文件走 electron-builder 的 `extraResources`：以**松散文件**形式落在
 * `<安装目录>\resources\` 下，运行时用 process.resourcesPath 定位。
 * dev 态没有 extraResources，回落到项目根 resources/。
 *
 * ⚠ 不要再给 main 进程的 fs 读取用 `?asset` —— 它只适合「构建期确定内容、
 * 打进 asar 也无妨」的场景。凡是 readFileSync/文件路径语义，一律走这里。
 */

import { app } from 'electron'
import { join } from 'path'

export function brandIconPath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, name)
    : join(app.getAppPath(), 'resources', name)
}
