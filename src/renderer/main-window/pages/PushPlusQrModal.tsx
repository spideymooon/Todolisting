import { useEffect } from 'react'
import { Icon } from '@renderer/shared/components/Icon'
// 直接 import 静态资源，Vite 会打进产物（dev 走源路径、打包后走 hash 文件名），
// 不依赖网络、不怕 Electron 打包后的绝对路径问题
import qrUrl from '@renderer/assets/pushplus_mp.jpg'

const STEPS = [
  '① 微信扫码关注 PushPlus',
  '② 关注后回复「token」',
  '③ 获取你的 PushPlus Token',
  '④ 将 Token 复制到 TodoList 设置中'
]

/**
 * PushPlus 扫码引导弹窗。
 *
 * 按需求文档的最小改动原则：只在用户点「获取 Token」时出现，平时不占任何布局。
 * 视觉复用任务编辑器的 modal 骨架（backdrop + modal），交互四条路关闭：
 * 右上角 ×、「我知道了」、点击遮罩、Esc。
 */
export function PushPlusQrModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  // Esc 关闭。监听 keydown 而不是依赖焦点元素 —— 弹窗里没有输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal qr-modal"
        role="dialog"
        aria-label="微信扫码关注 PushPlus"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button type="button" className="icon-btn qr-close" title="关闭 (Esc)" onClick={onClose}>
          <Icon name="close" size={14} strokeWidth={1.8} />
        </button>

        <div className="qr-body">
          <div className="qr-title">微信扫码关注 PushPlus</div>
          <img className="qr-img" src={qrUrl} alt="PushPlus 公众号二维码" draggable={false} />
          <div className="qr-sub">使用微信扫描二维码关注公众号</div>
          <ol className="qr-steps">
            {STEPS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>

        </div>

        <div className="qr-foot">
          <div className="qr-hint">已经关注？可直接关闭此窗口并填写 Token</div>
          <button type="button" className="btn btn-primary qr-ok" onClick={onClose}>
            我知道了
          </button>
        </div>
      </div>
    </div>
  )
}
