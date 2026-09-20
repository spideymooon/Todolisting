import type { Tag, TagColor } from '@shared/types'

const COLOR_VAR: Record<TagColor, string> = {
  red: 'var(--tag-red)',
  green: 'var(--tag-green)',
  blue: 'var(--tag-blue)',
  amber: 'var(--tag-amber)',
  purple: 'var(--tag-purple)',
  gray: 'var(--tag-gray)'
}

export function tagColorValue(color: TagColor): string {
  return COLOR_VAR[color] ?? COLOR_VAR.gray
}

/** 卡片第二行左侧的「彩色圆点 + 标签名」（1.png 的「工作 / 生活」） */
export function TagPill({ tag }: { tag: Tag }): React.JSX.Element {
  return (
    <span className="tag" title={tag.name}>
      <span className="tag-dot" style={{ background: tagColorValue(tag.color) }} />
      <span className="tag-name">{tag.name}</span>
    </span>
  )
}
