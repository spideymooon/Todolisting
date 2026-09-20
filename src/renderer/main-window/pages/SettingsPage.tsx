import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@renderer/shared/store/appStore'
import { PushPlusQrModal } from './PushPlusQrModal'
import { fmt, RemindersLogModal } from './RemindersLogModal'
import {
  REMINDER_DAY_PRESETS,
  type NotificationLog,
  type SchedulerStatus
} from '@shared/types'

export function SettingsPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const counts = useAppStore((s) => s.counts)
  const [dbPath, setDbPath] = useState('')
  const [status, setStatus] = useState<SchedulerStatus | null>(null)
  const [logs, setLogs] = useState<NotificationLog[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState(settings.pushplusToken)
  const [topicDraft, setTopicDraft] = useState(settings.pushplusTopic)
  const [checking, setChecking] = useState(false)
  // 扫码引导弹窗：平时不渲染，点了按钮才挂载（不占布局、无网络请求）。
  // ?qr=1 深链可直达弹层 —— 弹层类界面无法靠静态截图验证，与 ?edit=first 同理
  const [qrOpen, setQrOpen] = useState(
    () => new URLSearchParams(window.location.search).get('qr') === '1'
  )
  const [logsOpen, setLogsOpen] = useState(
    () => new URLSearchParams(window.location.search).get('logs') === '1'
  )

  const loadNotifyState = useCallback(async (): Promise<void> => {
    try {
      const [s, l] = await Promise.all([window.api.notify.status(), window.api.notify.logs(8)])
      setStatus(s)
      setLogs(l)
    } catch {
      // 读不到状态不该让设置页整页崩掉
    }
  }, [])

  useEffect(() => {
    void window.api.system.dbPath().then(setDbPath)
    void loadNotifyState()
    // 每 15 秒刷一次，让「待发条数 / 下一次提醒」保持接近实时
    const timer = window.setInterval(() => void loadNotifyState(), 15_000)
    return () => window.clearInterval(timer)
  }, [loadNotifyState])

  // PushPlus 的 token 是外部改动源（用户可能在别处复制粘贴），
  // 用 settings 作为单一真相同步草稿，避免两个输入框各说各话
  useEffect(() => {
    setTokenDraft(settings.pushplusToken)
    setTopicDraft(settings.pushplusTopic)
  }, [settings.pushplusToken, settings.pushplusTopic])

  const handleTest = async (): Promise<void> => {
    setFeedback('发送中…')
    const result = await window.api.notify.test()
    const parts: string[] = []
    if (result.desktop) parts.push(result.desktop.ok ? '桌面通知已发送 —— 看屏幕右下角' : `桌面失败：${result.desktop.error}`)
    if (result.wechat) parts.push(result.wechat.ok ? '微信已推送 —— 看手机' : `微信失败：${result.wechat.error}`)
    setFeedback(parts.length > 0 ? parts.join('；') : '没有任何可用的通知通道')
  }

  const handlePushPlusCheck = async (): Promise<void> => {
    setChecking(true)
    setFeedback('正在自检 PushPlus…')
    try {
      const r = await window.api.pushplus.check()
      setFeedback(r.ok ? 'PushPlus 通道正常 —— 手机上应该收到一条自检消息' : `PushPlus 失败：${r.error}`)
    } finally {
      setChecking(false)
    }
  }

  const handleTick = async (): Promise<void> => {
    const { status: next, result } = await window.api.notify.tick()
    setStatus(next)
    await loadNotifyState()
    if (!result) setFeedback('上一次检查还没跑完，稍后再试')
    else if (result.sent > 0) setFeedback(`本次发送 ${result.sent} 条提醒`)
    else if (result.due === 0) setFeedback('没有到期的提醒')
    else setFeedback(`待发 ${result.due} 条，本次未发送（可能都还没到执行时刻）`)
  }

  /** 更改数据存储位置：成功后主进程会 relaunch，这里的提示只闪现一瞬 */
  const handleChangeDbDir = async (): Promise<void> => {
    setFeedback('选择目录后数据文件会迁移过去，应用将自动重启…')
    const r = await window.api.system.changeDbDir()
    if (r.canceled) setFeedback(null)
    else if (r.error) setFeedback(`迁移失败：${r.error}`)
    else setFeedback('数据已迁移，正在重启应用…')
  }

  return (
    <div className="settings">
      <div className="settings-card">
        <div className="settings-subhead">提醒与通知</div>

        <div className="settings-row">
          <div>
            <div className="settings-label">桌面通知</div>
            <div className="settings-desc">Windows 原生通知，点击可打开应用并定位到该任务</div>
          </div>
          <button
            type="button"
            className={`toggle${settings.desktopNotifyEnabled ? ' is-on' : ''}`}
            onClick={() =>
              void updateSettings({ desktopNotifyEnabled: !settings.desktopNotifyEnabled })
            }
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">微信通知（PushPlus）</div>
            <div className="settings-desc">
              经 PushPlus 公众号推送到手机。需要先填下面的 Token 才能开启
            </div>
          </div>
          <button
            type="button"
            className={`toggle${settings.wechatNotifyEnabled ? ' is-on' : ''}`}
            disabled={!settings.pushplusToken.trim()}
            style={!settings.pushplusToken.trim() ? { opacity: 0.4 } : undefined}
            title={settings.pushplusToken.trim() ? '开启/关闭微信提醒' : '先填 PushPlus Token'}
            onClick={() =>
              void updateSettings({ wechatNotifyEnabled: !settings.wechatNotifyEnabled })
            }
          />
        </div>
      </div>

      {/* ── PushPlus 配置 ─────────────────────────────────────────────── */}
      <div className="settings-card">
        <div className="settings-subhead">PushPlus 微信推送</div>

        <div className="settings-row">
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div className="settings-label">Token</div>
            <input
              className="input"
              type="password"
              value={tokenDraft}
              placeholder="粘贴 PushPlus token"
              spellCheck={false}
              onChange={(e) => setTokenDraft(e.target.value)}
              onBlur={() => {
                const v = tokenDraft.trim()
                if (v !== settings.pushplusToken) void updateSettings({ pushplusToken: v })
              }}
            />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              flex: '0 0 auto',
              alignItems: 'flex-end'
            }}
          >
            <button type="button" className="header-link" onClick={() => setQrOpen(true)}>
              获取token
            </button>
            <button
              type="button"
              className="header-link"
              disabled={checking || !settings.pushplusToken.trim()}
              onClick={() => void handlePushPlusCheck()}
            >
              {checking ? '自检中…' : '测试连接'}
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div className="settings-label">群组编码（可选）</div>
            <div className="settings-desc">填了就是一对多推送，留空则只推给自己</div>
            <input
              className="input"
              value={topicDraft}
              placeholder="留空 = 一对一向自己推送"
              spellCheck={false}
              onChange={(e) => setTopicDraft(e.target.value)}
              onBlur={() => {
                const v = topicDraft.trim()
                if (v !== settings.pushplusTopic) void updateSettings({ pushplusTopic: v })
              }}
            />
          </div>
        </div>
      </div>

      {/* ── 常驻与启动 ────────────────────────────────────────────────── */}
      <div className="settings-card">
        <div className="settings-subhead">后台常驻</div>

        <div className="settings-row">
          <div>
            <div className="settings-label">关闭窗口时最小化到托盘</div>
            <div className="settings-desc">
              开启后点关闭只会隐藏窗口，提醒引擎继续运行。关掉它则关闭即退出（此时不会有提醒）
            </div>
          </div>
          <button
            type="button"
            className={`toggle${settings.closeToTray ? ' is-on' : ''}`}
            onClick={() => void updateSettings({ closeToTray: !settings.closeToTray })}
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">开机自动启动</div>
            <div className="settings-desc">随系统启动，但不弹出窗口，静默在托盘里等提醒</div>
          </div>
          <button
            type="button"
            className={`toggle${settings.launchAtLogin ? ' is-on' : ''}`}
            onClick={() => void updateSettings({ launchAtLogin: !settings.launchAtLogin })}
          />
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-label">默认提前</div>
            <div className="settings-desc">新建任务时的初始值。改动只影响之后新建的任务，不会重排已有任务</div>
          </div>
          <div className="seg">
            {REMINDER_DAY_PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                className={settings.defaultReminderDays === d ? 'is-active' : ''}
                onClick={() => void updateSettings({ defaultReminderDays: d })}
              >
                {d === 0 ? '当天' : `${d}天`}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">默认提醒时间</div>
            <div className="settings-desc">本地时区的 `HH:mm`</div>
          </div>
          <input
            type="time"
            className="input"
            style={{ width: 110 }}
            value={settings.defaultReminderTime}
            onChange={(e) =>
              void updateSettings({ defaultReminderTime: e.target.value || '09:00' })
            }
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">逾期策略</div>
            <div className="settings-desc">错过截止日期的任务，是否还补一次提醒</div>
          </div>
          <div className="seg">
            <button
              type="button"
              className={settings.overduePolicy === 'once' ? 'is-active' : ''}
              onClick={() => void updateSettings({ overduePolicy: 'once' })}
            >
              补一次
            </button>
            <button
              type="button"
              className={settings.overduePolicy === 'never' ? 'is-active' : ''}
              onClick={() => void updateSettings({ overduePolicy: 'never' })}
            >
              不再提醒
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div style={{ minWidth: 0 }}>
            <div className="settings-label">
              提醒引擎 {status?.running ? '· 运行中' : '· 已停止'}
            </div>
            <div className="settings-desc" style={{ lineHeight: 1.7 }}>
              待发计划 {status?.pendingCount ?? 0} 条
              {status?.nextDueAt
                ? ` · 下一次 ${fmt(status.nextDueAt)}${status.nextDueTitle ? ` 「${status.nextDueTitle}」` : ''}`
                : ' · 暂无排期'}
              <br />
              上次检查 {fmt(status?.lastTickAt ?? null)}
              {logs.some((l) => l.status === 'planned') ? ' · 30 秒一轮' : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
            <button type="button" className="header-link" onClick={() => void handleTest()}>
              发送测试通知
            </button>
            <button type="button" className="header-link" onClick={() => void handleTick()}>
              立即检查
            </button>
          </div>
        </div>

        {feedback && (
          <div className="settings-desc" style={{ color: 'var(--accent)', marginTop: 4 }}>
            {feedback}
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-subhead">提醒日志</div>
        <div className="settings-desc" style={{ marginBottom: 8 }}>
          每条任务计划只发送一次 —— 这张表就是防重复通知的审计痕迹
        </div>
        <div className="settings-row" style={{ borderBottom: 'none' }}>
          <div>
            <div className="settings-label">
              共 {logs.length} 条记录
              {logs.some((l) => l.status === 'failed' || l.status === 'cancelled')
                ? ' · 有可重发的失败项'
                : ''}
            </div>
            <div className="settings-desc">点「查看详情」查看完整列表与失败原因</div>
          </div>
          <button type="button" className="header-link" onClick={() => setLogsOpen(true)}>
            查看详情
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-label">捕获条默认落点</div>
            <div className="settings-desc">
              打开就输入、按 Enter 时，没写日期的任务落到哪里。写了「明天」「9-20」这类词时以词为准。
            </div>
          </div>
          <div className="seg">
            <button
              type="button"
              className={settings.captureDefaultTarget === 'today' ? 'is-active' : ''}
              onClick={() => void updateSettings({ captureDefaultTarget: 'today' })}
            >
              今天
            </button>
            <button
              type="button"
              className={settings.captureDefaultTarget === 'pool' ? 'is-active' : ''}
              onClick={() => void updateSettings({ captureDefaultTarget: 'pool' })}
            >
              待办池
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">主题</div>
            <div className="settings-desc">跟随系统 / 浅色 / 深色，主窗口与桌面小组件同步生效</div>
          </div>
          <div className="seg">
            {(
              [
                ['system', '跟随系统'],
                ['light', '浅色'],
                ['dark', '深色']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={settings.theme === value ? 'is-active' : ''}
                onClick={() => void updateSettings({ theme: value })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div style={{ minWidth: 0 }}>
            <div className="settings-label">数据文件</div>
            <div className="settings-desc code" style={{ wordBreak: 'break-all' }}>
              {dbPath || '读取中…'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, flex: '0 0 auto' }}>
            <button type="button" className="header-link" onClick={() => void handleChangeDbDir()}>
              更改目录
            </button>
            <button
              type="button"
              className="header-link"
              onClick={() => void window.api.system.revealDb()}
            >
              打开所在文件夹
            </button>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">当前数据量</div>
            <div className="settings-desc">
              未完成 {counts?.allCount ?? 0} · 已完成 {counts?.completedCount ?? 0}
              {counts && counts.overdueCount > 0 ? ` · 逾期 ${counts.overdueCount}` : ''}
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-label">当前版本：v1.5 品牌与体验完善</div>
            <div className="settings-desc" style={{ lineHeight: 1.8 }}>
              已就位：SQLite 本地库 + 版本化迁移 · 任务 CRUD + 编辑器 · 常驻捕获条 · 看板三列与拖拽 ·
              四个列表页 · 全局搜索 · 提醒时刻计算 · Windows 桌面通知 · PushPlus 微信推送（扫码获取
              Token）· 提醒调度器 · 防重复通知四道防线 · 提醒日志与手动重发 · 系统托盘常驻 ·
              开机启动 · 桌面小组件（置顶 / 透明度）· 无边框窗口与自绘标题栏 · 深色主题 ·
              品牌图标（托盘 / 任务栏）· 存储目录自定义
              <br />
              尚未接入：重复任务、数据导入导出、应用打包
            </div>
          </div>
        </div>
      </div>

      {qrOpen && <PushPlusQrModal onClose={() => setQrOpen(false)} />}
      {logsOpen && <RemindersLogModal onClose={() => setLogsOpen(false)} />}
    </div>
  )
}
