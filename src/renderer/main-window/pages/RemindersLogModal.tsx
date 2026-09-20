import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@renderer/shared/components/Icon'
import type { NotificationLog } from '@shared/types'

export const LOG_STATUS_LABEL: Record<NotificationLog['status'], string> = {
  planned: '待发',
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消'
}

export function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 弹窗里一次拉多少条。审计日志会越积越多，100 条足够回溯最近的情况 */
const LOG_LIMIT = 100

/**
 * 提醒日志弹窗（设置页「查看详情」入口）。
 *
 * 设置页里只留一行摘要 + 入口按钮，完整审计记录收进这里：
 * 避免日志把设置页越撑越长。复用 modal 骨架，×/遮罩/Esc/「关闭」四路退出。
 */
export function RemindersLogModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [logs, setLogs] = useState<NotificationLog[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setLogs(await window.api.notify.logs(LOG_LIMIT))
    } catch {
      // 读不到不弹错，列表空态即可 —— 弹窗不该因后台抖动崩掉
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleRetry = async (logId: string): Promise<void> => {
    await window.api.notify.retry(logId)
    await load()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal log-modal"
        role="dialog"
        aria-label="提醒日志"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">提醒日志</div>
          <button type="button" className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <Icon name="close" size={14} strokeWidth={1.8} />
          </button>
        </div>

        <div className="modal-body log-modal-body">
          {!loaded ? (
            <div className="dots">
              <span className="dot" />
              <span className="dot" />
              <span className="dot" />
            </div>
          ) : logs.length === 0 ? (
            <div className="empty">还没有任何提醒记录</div>
          ) : (
            <div className="log-list">
              {logs.map((log) => (
                <div key={log.id} className="log-item">
                  <span className={`log-status s-${log.status}`}>
                    {LOG_STATUS_LABEL[log.status]}
                  </span>
                  <span className="log-title" title={log.error ?? log.planKey}>
                    {log.taskTitle || '(已删除的任务)'}
                  </span>
                  <span className="log-time">{fmt(log.scheduledAt)}</span>
                  {(log.status === 'failed' || log.status === 'cancelled') && (
                    <button
                      type="button"
                      className="header-link"
                      title={log.error ?? ''}
                      onClick={() => void handleRetry(log.id)}
                    >
                      重发
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="settings-desc">
            最近 {logs.length} 条 · 每条任务计划只发送一次
          </span>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
