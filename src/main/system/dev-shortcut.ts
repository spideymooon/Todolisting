/**
 * Windows 任务栏 / 开始菜单快捷方式的 AUMID 与图标注册。
 *
 * ─── 问题背景 ───────────────────────────────────────────────
 * Windows 任务栏的图标按「AppUserModelID 分组」取图，优先级：
 *   AUMID 注册的快捷方式（.lnk 里的 System.AppUserModel.ID）
 *     → exe 内嵌图标
 *     → 空（白纸+蓝窗的通用图标）
 *
 * 而 electron-builder 的 NSIS 安装器创建快捷方式用的是原生指令
 * （见 app-builder-lib/templates/nsis/include/installer.nsh）：
 *   CreateShortCut "link.lnk" "target.exe" "" "icon.exe" 0 "" "" "desc"
 * 这个指令**没有 AppUserModelId 参数位**，所以安装出来的快捷方式一律
 * **不带 System.AppUserModel.ID**。
 *
 * 运行时 app.setAppUserModelId('com.desktoptodo.app') 会让进程带上 AUMID，
 * 但快捷方式里没有对应登记 → 任务栏按 AUMID 找不到 → 显示通用图标。
 *
 * ─── 为什么不能只在「启动时补写」 ──────────────────────────
 * 早期实现（v1.5.x）只做两件事：打包态启动时给「开始菜单 + 桌面」两个 lnk
 * 补写 AUMID。实测在**另一台机器直接失败**，因为：
 *   1. 用户装完应用常常**先右键「固定到任务栏」再启动** —— pin 的那一刻
 *      快捷方式还没被补写，任务栏里存的仍是安装器创建的无 AUMID 版本；
 *   2. 覆盖范围不全：只写用户级开始菜单，漏了 ProgramData 全局开始菜单
 *      （perMachine 安装走这条）、以及任务栏固定区本身。
 * 结果同一份安装包在「先启动过、pin 得晚」的机器上正常，在「先 pin、后启动」
 * 或「用全局开始菜单 pin」的机器上白板 —— 表现为「换台电脑就不对」。
 *
 * ─── 解法 ──────────────────────────────────────────────────
 * setAppUserModelId 必须**尽早**（ready 之前）调用，让进程 AUMID 从第一帧就
 * 正确；快捷方式补写则**枚举所有已知位置**、且**每次启动都重写一遍**
 * （幂等），用户哪天补 pin 也会在下次启动时被修正。
 */

import { app, shell } from 'electron'
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'

/** 与 package.json build.appId 必须完全一致 —— 任务栏按这个串归组 */
export const APP_USER_MODEL_ID = 'com.desktoptodo.app'

/** 安装器与脚本都用的快捷方式名 */
const SHORTCUT_NAME = 'TodoList.lnk'

/** 品牌图标相对 exe 的兜底位置（图标已由 electron-builder 内嵌进 exe） */
function iconForShortcut(): { icon: string; iconIndex: number } {
  // 优先用 exe 内嵌图标：安装器就是这么建的，行为一致、且不依赖 resources 目录
  return { icon: process.execPath, iconIndex: 0 }
}

/** 收集所有可能出现 TodoList 快捷方式的目录 */
function shortcutCandidates(): string[] {
  const out: string[] = []
  const push = (dir: string | null, ...rest: string[]): void => {
    if (!dir) return
    out.push(join(dir, ...rest, SHORTCUT_NAME))
  }

  const appData = app.getPath('appData')
  const programData = process.env['ProgramData'] ?? 'C:\\ProgramData'

  // 1. 用户级开始菜单（electron-builder 默认安装位置）
  push(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  // 2. 全局开始菜单（perMachine 安装 / 所有用户）
  push(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  // 3. 桌面（NSIS createDesktopShortcut）
  push(app.getPath('desktop'))
  // 4. 公共桌面（perMachine 时快捷方式可能落在这里）
  push(process.env['PUBLIC'] ?? 'C:\\Users\\Public', 'Desktop')

  return out
}

/**
 * 任务栏固定区的 lnk 是 Windows 自己拷过去的副本，文件名由系统决定
 * （可能变成 "TodoList (1).lnk" 之类），所以要按**目录扫描**而不是拼固定名。
 */
function pinnedTaskbarLinks(): string[] {
  const home = process.env['APPDATA']
  if (!home) return []
  const dir = join(home, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().startsWith('todolist') && n.toLowerCase().endsWith('.lnk'))
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/** 只覆盖 AUMID / 图标，target 与参数保持原样（'update' 语义） */
function patchAumid(link: string): boolean {
  try {
    const { icon, iconIndex } = iconForShortcut()
    return shell.writeShortcutLink(link, 'update', {
      target: process.execPath,
      appUserModelId: APP_USER_MODEL_ID,
      icon,
      iconIndex
    })
  } catch (err) {
    console.warn('[aumid] 补写快捷方式失败', link, err)
    return false
  }
}

/**
 * 打包态：把 AUMID 补写进所有已知位置的快捷方式（含任务栏固定区）。
 *
 * 用 writeShortcutLink('update') 只覆盖 AUMID / 图标字段，
 * 其余（target / 参数 / 安装目录）保持安装器写好的不动。
 * 幂等：重复执行无副作用，所以每次启动都跑一遍 —— 这样用户任何时刻补 pin
 * 的快捷方式，都会在下一次启动后被修正。
 */
export function ensureInstalledShortcutAumid(): void {
  const links = [...shortcutCandidates(), ...pinnedTaskbarLinks()]
  let patched = 0
  let pinnedPatched = false
  const report: string[] = []
  for (const link of links) {
    const exists = existsSync(link)
    if (!exists) {
      report.push(`MISS  ${link}`)
      continue
    }
    if (!patchAumid(link)) {
      report.push(`FAIL  ${link}`)
      continue
    }
    patched++
    report.push(`OK    ${link}`)
    // 任务栏固定区的副本改了内容后，Explorer 不一定重读 —— 需要显式刷新
    if (link.includes('User Pinned')) pinnedPatched = true
  }
  const summary = `[aumid] 快捷方式补写完成：${patched}/${links.length} 个位置命中 AUMID=${APP_USER_MODEL_ID}`
  console.log(summary)
  writeDiagnose(summary, report)
  if (pinnedPatched) refreshTaskbar()
}

/**
 * 把诊断结果落盘到 userData/aumid-diagnose.txt。
 *
 * 动机：Windows 打包版是 GUI 子系统，**stdout/stderr 不接管道** ——
 * 实测 spawn 安装版拿不到任何控制台输出，日志里那几行 console.log
 * 用户根本看不到、也无法回传。远程排查任务栏图标问题时，
 * 让用户把这个文件发过来是最省事的取证方式。
 */
function writeDiagnose(summary: string, report: string[]): void {
  try {
    const dir = app.getPath('userData')
    const body = [
      summary,
      `exe        = ${process.execPath}`,
      `isPackaged = ${app.isPackaged}`,
      `时间        = ${new Date().toISOString()}`,
      '',
      '--- 各位置明细 ---',
      ...report
    ].join('\n')
    writeFileSync(join(dir, 'aumid-diagnose.txt'), body, 'utf8')
  } catch (err) {
    console.warn('[aumid] 诊断文件写入失败', err)
  }
}

/**
 * 让任务栏重新读取固定项快捷方式。
 *
 * 背景：任务栏图标是按 AUMID 归组取图的，pin 的那一刻 Windows 会把快捷方式
 * **拷贝**到 User Pinned\TaskBar 下 —— 如果那一刻快捷方式还没带 AUMID，
 * 这份副本就永远是「无 AUMID」状态，之后改开始菜单/桌面那份也**不会同步**。
 * 这就是「装了应用、pin 到任务栏、还是白板」的直接原因。
 *
 * 我们在启动时会把这份副本一起补写（pinnedTaskbarLinks），但 Explorer 有缓存，
 * 默认要等重启才认。所以显式通知 shell 刷新一次。
 *
 * 实现说明：Windows 没有「只刷新任务栏」的干净 API。这里用 SHChangeNotify
 * 广播 shell 变更（等价于用户改动文件后让资源管理器重新读），
 * 不重启 Explorer 进程 —— 避免闪烁和打断用户工作。
 *
 * 为什么用 spawn 而不是 execFile：execFile 会缓冲输出且默认挂一个 200ms 的
 * 等待；这里要的是「发完就走」，不关心结果。
 */
function refreshTaskbar(): void {
  try {
    const script = [
      '$s = "[DllImport(\\"shell32.dll\\")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);"',
      'Add-Type -MemberDefinition $s -Name S -Namespace W',
      '[W.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)'
    ].join('; ')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.on('error', (err) => {
      console.warn('[aumid] 任务栏刷新失败（不影响功能，下次重启后正常）', err.message)
    })
    child.unref()
  } catch (err) {
    console.warn('[aumid] 任务栏刷新异常', err)
  }
}

/**
 * 开发态：在开始菜单注册一个带相同 AUMID + 品牌图标的快捷方式。
 *
 * 开发态跑在 electron.exe 上，什么都不做就是原子图；就算用 rcedit 把品牌图
 * 嵌进 exe，Explorer 的任务栏缓存也可能继续回吐旧图（实测踩坑）。
 * 注册一个带 AUMID 的快捷方式后，任务栏按 AUMID 找到它，图标从此恒定。
 *
 * 副作用说明：这个 lnk 也能正常启动应用（target 指向 electron.exe，
 * 工作目录是项目根、参数 "."），用户从开始菜单点它和在项目目录跑 electron . 等效。
 */
export function ensureDevStartMenuShortcut(): void {
  try {
    const programs = join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs'
    )
    const link = join(programs, SHORTCUT_NAME)
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
  } catch (err) {
    // 快捷方式写失败只影响任务栏图标显示，不能挡启动
    console.warn('[aumid] 开发态开始菜单快捷方式注册失败', err)
  }
}
