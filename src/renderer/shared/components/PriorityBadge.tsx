import type { Priority } from '@shared/types'

export const PRIORITY_META: Record<Priority, { label: string; color: string }> = {
  1: { label: 'P1', color: 'var(--pri-urgent)' },
  2: { label: 'P2', color: 'var(--pri-important)' },
  3: { label: 'P3', color: 'var(--pri-normal)' }
}

export const PRIORITY_ORDER: Priority[] = [1, 2, 3]

export function PriorityBadge({ priority }: { priority: Priority }): React.JSX.Element {
  const meta = PRIORITY_META[priority]
  return (
    <span className="card-pri" style={{ color: meta.color }} title={`优先级 ${meta.label}`}>
      {meta.label}
    </span>
  )
}
