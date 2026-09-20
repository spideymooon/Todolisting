import type { DueTone } from '@shared/date'

/** 到期状态的语义色：红色只留给「已逾期」 */
export const DUE_TONE_COLOR: Record<DueTone, string> = {
  overdue: 'var(--due-overdue)',
  today: 'var(--due-today)',
  soon: 'var(--due-soon)',
  normal: 'var(--text-tertiary)'
}
