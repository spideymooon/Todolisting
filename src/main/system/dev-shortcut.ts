/**
 * 开发态的 AUMID 图标注册。
 *
 * 问题背景：Windows 任务栏的图标按「AppUserModelID 分组」取图，优先级是
 *   AUMID 注册的快捷方式（开始菜单 .lnk 里的 System.AppUserModel.ID）→ exe 内嵌图标 → 空
 * 开发态跑在 electron.exe 上，什么都不做就是原子图；就算用 rcedit 把品牌图
 * 嵌进 exe，Explorer 的任务栏缓存也可能继续回吐旧图（实测踩坑）。
 *
 * 解法（Electron 官方对 Win 通知/任务栏的推荐做法）：开发态也固定 AUMID，
 * 并在开始菜单放一个**带相同 AUMID + 品牌图标**的快捷方式 —— 任务栏按
 * AUMID 找到它，图标从此恒定。打包后走安装器创建的快捷方式，不需要这段。
 *
 * 副作用说明：这个 lnk 也能正常启动应用（target 指向 electron.exe，
 * 工作目录是项目根、参数 "."），用户从开始菜单点它和在项目目录跑 electron . 等效。
 */

import { app, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export const APP_USER_MODEL_ID = 'com.desktoptodo.app'

export function ensureDevStartMenuShortcut(): void {
  try {
    const programs = join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    )
    const link = join(programs, 'TodoList.lnk')
    const icon = join(app.getAppPath(), 'build', 'icon.ico')
    const options = {
      target: process.execPath,
      args: '.',
      cwd: app.getAppPath(),
      icon: existsSync(icon) ? icon : process.execPath,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
      description: '极简桌面 TodoList'
    }
    // ⚠ 'replace' 在 lnk 不存在时会直接失败（Electron 文档行为），必须先判存在
    shell.writeShortcutLink(link, existsSync(link) ? 'replace' : 'create', options)
  } catch {
    // 快捷方式写失败只影响任务栏图标显示，不能挡启动
  }
}
