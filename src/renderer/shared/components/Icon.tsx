import type { JSX } from 'react'

export type IconName =
  | 'calendar'
  | 'board'
  | 'clock'
  | 'list'
  | 'check-circle'
  | 'gear'
  | 'plus'
  | 'more'
  | 'trash'
  | 'search'
  | 'bell'
  | 'edit'
  | 'close'
  | 'widget'
  | 'repeat'

const PATHS: Record<IconName, JSX.Element> = {
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v2.4M10.5 2v2.4" />
    </>
  ),
  board: (
    <>
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.8v3.4l2.1 1.4" />
    </>
  ),
  list: (
    <>
      <path d="M5.8 4.5h7.7M5.8 8h7.7M5.8 11.5h7.7" />
      <circle cx="3" cy="4.5" r="0.85" />
      <circle cx="3" cy="8" r="0.85" />
      <circle cx="3" cy="11.5" r="0.85" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M5.6 8.2l1.7 1.8 3.1-3.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2" />
    </>
  ),
  plus: <path d="M8 3.6v8.8M3.6 8h8.8" />,
  more: (
    <>
      <circle cx="3.6" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.4" cy="8" r="1" />
    </>
  ),
  trash: <path d="M3 4.8h10M6.4 4.8V3.4h3.2v1.4M4.4 4.8l.6 8.1h6l.6-8.1" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.2 10.2l3.3 3.3" />
    </>
  ),
  bell: (
    <>
      <path d="M8 2.4a3.5 3.5 0 0 0-3.5 3.5c0 3.5-1.4 4.6-1.4 4.6h9.8s-1.4-1.1-1.4-4.6A3.5 3.5 0 0 0 8 2.4Z" />
      <path d="M6.5 12.7a1.6 1.6 0 0 0 3 0" />
    </>
  ),
  edit: (
    <>
      <path d="M11.1 2.9a1.65 1.65 0 0 1 2.3 2.3l-7.3 7.3-3 .7.7-3 7.3-7.3Z" />
      <path d="M9.9 4.1l2.3 2.3" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  /** 桌面小组件：一块面板 + 右下角挂件，呼应「贴在桌面上的便签」 */
  widget: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.8" />
      <rect x="8.4" y="7.4" width="4" height="4" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  /** 重复任务：两条首尾相接的循环箭头，一眼能认出是「循环」而不是「刷新」 */
  repeat: (
    <>
      <path d="M4.4 5.6h7.2a2.4 2.4 0 0 1 2.4 2.4v.6" />
      <path d="M6.6 3.4 4.4 5.6l2.2 2.2" />
      <path d="M11.6 10.4H4.4A2.4 2.4 0 0 1 2 8v-.6" />
      <path d="M9.4 12.6l2.2-2.2-2.2-2.2" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.5
}: {
  name: IconName
  size?: number
  strokeWidth?: number
}): JSX.Element {
  const filled = name === 'more'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      {PATHS[name]}
    </svg>
  )
}
