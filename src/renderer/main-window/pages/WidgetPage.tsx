import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@renderer/shared/store/appStore'
import type { WidgetStatus } from '@shared/types'
import { WIDGET_SCOPE_OPTIONS } from '@renderer/widgets/widgetStore'

/**
 * 「小组件」独立页（从设置页拆出，用户反馈：桌面挂件的开关属于日常操作，
 * 不该埋在设置深处）。复用 settings-card 的视觉语言，保持一致观感。
 */
export function WidgetPage(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [widget, setWidget] = useState<WidgetStatus | null>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setWidget(await window.api.widget.status())
    } catch {
      // 读不到状态不砸页面
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  return (
    <div className="settings">
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <div className="settings-label">
              显示小组件 {widget?.visible ? '· 已显示' : widget?.enabled ? '· 待显示' : ''}
            </div>
            <div className="settings-desc">
              贴在桌面上的待办便签，显示内容在下方选择。
              也可以直接点小组件头部的 ✕ 关闭
            </div>
          </div>
          <button
            type="button"
            className={`toggle${settings.widgetEnabled ? ' is-on' : ''}`}
            onClick={() =>
              void updateSettings({ widgetEnabled: !settings.widgetEnabled }).then(() =>
                loadStatus()
              )
            }
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">显示内容</div>
            <div className="settings-desc">
              小组件里显示哪个页面的任务，默认显示全部未完成任务。修改后桌面小组件实时生效
            </div>
          </div>
          <div className="seg">
            {WIDGET_SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={(settings.widgetScope ?? 'all') === opt.value ? 'is-active' : ''}
                onClick={() => void updateSettings({ widgetScope: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">窗口置顶</div>
            <div className="settings-desc">
              一直浮在其他窗口之上。小组件头部的图钉按钮与这里是同一个开关
            </div>
          </div>
          <button
            type="button"
            className={`toggle${settings.widgetAlwaysOnTop ? ' is-on' : ''}`}
            disabled={!settings.widgetEnabled}
            style={!settings.widgetEnabled ? { opacity: 0.4 } : undefined}
            onClick={() =>
              void updateSettings({ widgetAlwaysOnTop: !settings.widgetAlwaysOnTop }).then(() =>
                loadStatus()
              )
            }
          />
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">位置</div>
            <div className="settings-desc">
              直接拖动小组件标题栏即可移动，位置会自动记住（默认右下角）
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">背景不透明度</div>
            <div className="settings-desc">
              越低越通透，太低会看不清字。调整后小组件实时生效
            </div>
          </div>
          <div className="seg">
            {[100, 90, 80, 70, 60].map((v) => (
              <button
                key={v}
                type="button"
                className={
                  (settings.widgetOpacity ?? 86) >= v &&
                  (settings.widgetOpacity ?? 86) < (v === 100 ? 999 : v + 10)
                    ? 'is-active'
                    : ''
                }
                onClick={() => void updateSettings({ widgetOpacity: v })}
              >
                {v === 100 ? '不透明' : `${v}%`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
