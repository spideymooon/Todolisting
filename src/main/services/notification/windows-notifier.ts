/**
 * Windows 原生桌面通知（《00-架构设计》§5.2）。
 *
 * 这是 Notifier 接口在 Windows 上的实现 —— core 层的 NotificationService
 * 只认接口，不知道 Electron 的存在。
 *
 * ⚠ 一个必须在架构上记住的约束：通知的 **click 回调只在应用进程存活时有效**。
 * 所以托盘常驻是通知功能的硬依赖 —— 相位 3 交付托盘后这个依赖才闭环：
 * 用户关掉主窗口后进程还在（隐藏到托盘），点通知才能打开应用并定位任务。
 */

import { Notification } from 'electron'
import type { Notifier } from '../../core/notification/notification.service'
import type { NotifyMessage } from '../../core/notification/notification.message'
import type { NotifyResult } from '@shared/types'

export class WindowsNotifier implements Notifier {
  readonly key = 'desktop' as const

  /**
   * 持有引用。Electron 的 Notification 实例如果被 GC，通知会提前消失，
   * 点击回调也就永远不会触发 —— 这是 Electron 上很隐蔽的一个坑。
   */
  private readonly live = new Set<Notification>()

  constructor(private readonly onActivate: (taskId: string | null) => void) {}

  async send(msg: NotifyMessage): Promise<NotifyResult> {
    if (!Notification.isSupported()) {
      return { ok: false, error: '当前系统不支持桌面通知' }
    }

    try {
      const notification = new Notification({
        title: msg.title,
        body: msg.body,
        // 两条提醒叠在一起时应该各自成组，而不是互相顶掉
        timeoutType: 'default',
        silent: false
      })

      notification.on('click', () => {
        // 测试通知的 taskId 是空串 —— 点了只打开窗口，不去定位（没有可定位的任务）
        this.onActivate(msg.taskId || null)
      })

      const release = (): void => {
        this.live.delete(notification)
      }
      notification.on('close', release)
      notification.on('failed', release)

      this.live.add(notification)
      notification.show()

      // show() 是 fire-and-forget，Electron 不回报 toast 是否真的出现在屏幕上了
      // （通知中心被系统策略禁用时也一样返回成功）。所以这里只保证「已投递到系统」。
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 隐藏到托盘时的一次性提示。
   *
   * 解决的问题：用户点关闭，窗口消失，但进程还活着 —— 如果没有提示，
   * 用户会以为应用已退出，之后收到提醒会感到困惑（「我明明关了」）。
   * 这是「关窗 ≠ 退出」这个设计必须付的告知成本。
   */
  notifyHiddenToTray(): void {
    if (!Notification.isSupported()) return
    try {
      const n = new Notification({
        title: 'TodoList 仍在后台运行',
        body: '提醒引擎已保持运行。点击托盘图标或这里可以重新打开窗口。',
        silent: true
      })
      n.on('click', () => this.onActivate(''))
      n.on('close', () => this.live.delete(n))
      n.on('failed', () => this.live.delete(n))
      this.live.add(n)
      n.show()
    } catch {
      // 提示失败无所谓，不能因为它影响隐藏动作本身
    }
  }

  /** 退出时清掉，避免托盘残留幽灵通知 */
  disposeAll(): void {
    for (const n of this.live) {
      try {
        n.close()
      } catch {
        // 已经关掉的再关一次会抛，忽略
      }
    }
    this.live.clear()
  }
}
