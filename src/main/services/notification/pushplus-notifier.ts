/**
 * PushPlus 微信推送通道（需求 §6）。
 *
 * 实现 NotificationService 的 `Notifier` 接口，注册为 key='wechat'。
 * 本文件**不 import Electron** —— 它只是个 HTTP 客户端，这样能脱离 Electron 单测。
 *
 * 为什么用 PushPlus：公众号推送需要企业资质、Server 酱免费额度太小，
 * PushPlus 只需用户扫一次码拿 token 就能推给自己，是「本地桌面应用给手机发微信」
 * 这个场景下门槛最低的方案。用户侧的成本只有一步：注册后复制 token 填进设置页。
 *
 * §19 离线优先：所有失败都必须**只返回结果、不抛异常**。微信通道挂掉绝不能让
 * 任务创建/完成失败，也不能让调度器 tick 中断。
 */

import type { Notifier, NotifyChannelKey } from '../../core/notification/notification.service'
import type { NotifyMessage } from '../../core/notification/notification.message'
import type { PushPlusCheck } from '@shared/types'

const ENDPOINT = 'https://www.pushplus.plus/send'
const TIMEOUT_MS = 10_000

/** PushPlus 的响应体。code=200 才算成功 */
interface PushPlusResponse {
  code?: number
  msg?: string
  data?: string
}

export interface PushPlusConfig {
  token: string
  /** 群组编码。留空 = 一对一推送给自己 */
  topic: string
}

/**
 * 把通知消息转成 PushPlus 的 HTML 正文。
 *
 * PushPlus 的 `content` 支持 HTML，微信里渲染成富文本卡片。
 * 这里刻意用最简单的内联样式 —— 微信会剥掉大部分 CSS，复杂样式反而乱。
 */
function toHtml(msg: NotifyMessage): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const lines = msg.body
    .split('\n')
    .map((l) => esc(l.trim()))
    .filter(Boolean)
    .join('<br/>')

  return [
    `<div style="font-size:16px;font-weight:600;">${esc(msg.title)}</div>`,
    `<div style="margin-top:8px;line-height:1.7;">${lines}</div>`,
    msg.detail
      ? `<div style="margin-top:10px;color:#888;font-size:12px;">${esc(msg.detail)}</div>`
      : ''
  ]
    .filter(Boolean)
    .join('')
}

export class PushPlusNotifier implements Notifier {
  readonly key: NotifyChannelKey = 'wechat'

  constructor(
    /** 每次发送时现读配置 —— token 是用户随时可能在设置页改的 */
    private readonly config: () => PushPlusConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(msg: NotifyMessage): Promise<{ ok: boolean; error?: string }> {
    const { token, topic } = this.config()
    if (!token.trim()) {
      return { ok: false, error: '未配置 PushPlus token' }
    }

    // timeout 用 AbortSignal.timeout 而不是手搓 Promise.race：
    // 前者会真正中止请求，后者只是不再等待，socket 会挂着
    try {
      const res = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim(),
          title: msg.title,
          content: toHtml(msg),
          template: 'html',
          ...(topic.trim() ? { topic: topic.trim() } : {})
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })

      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` }
      }

      const body = (await res.json()) as PushPlusResponse
      if (body.code === 200) return { ok: true }
      // PushPlus 用业务码区分「token 无效」「超过发送次数」等，原样透出便于用户排查
      return { ok: false, error: `PushPlus: ${body.msg ?? `code ${body.code ?? '未知'}`}` }
    } catch (err) {
      // 网络不通 / 超时 / 响应不是 JSON —— 全部收敛成一条错误，不上抛
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 设置页的「测试连接」。
   *
   * 与 send() 的区别：这里发一条**固定的自检消息**，让用户能立刻确认
   * token 有效且手机上真能收到 —— 否则第一次验证要等到某天早晨 09:00。
   */
  async check(): Promise<PushPlusCheck> {
    const { token } = this.config()
    if (!token.trim()) return { ok: false, error: '未配置 PushPlus token' }
    const r = await this.send({
      taskId: '',
      planKey: 'pushplus-check',
      title: '📌 TodoList 通道自检',
      body: '如果你在微信里看到了这条消息，说明 PushPlus 通道已经通了。',
      detail: '这条消息由设置页的「测试连接」按钮发出。'
    })
    return { ok: r.ok, error: r.error }
  }
}
