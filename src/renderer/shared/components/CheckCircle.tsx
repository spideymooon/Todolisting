/** 勾选圆圈。用 SVG 画，不用 ○/✓ 字符 —— 跨字体基线不稳（《01-UI设计规范》§4） */
export function CheckCircle({
  done,
  onToggle,
  title
}: {
  done: boolean
  onToggle: () => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`check${done ? ' is-done' : ''}`}
      title={title ?? (done ? '标记为未完成' : '标记为完成')}
      aria-pressed={done}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path
          d="M2.2 6.2L4.6 8.6L9.8 3.4"
          fill="none"
          stroke="#fff"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
