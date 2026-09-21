import { useAppStore, type PageKey } from '@renderer/shared/store/appStore'
import { Icon, type IconName } from '@renderer/shared/components/Icon'

interface NavDef {
  key: Exclude<PageKey, 'settings'>
  icon: IconName
  label: string
}

const NAV: NavDef[] = [
  { key: 'today', icon: 'calendar', label: '今天' },
  { key: 'board', icon: 'board', label: '看板' },
  { key: 'upcoming', icon: 'clock', label: '待办任务' },
  { key: 'all', icon: 'list', label: '全部任务' },
  { key: 'completed', icon: 'check-circle', label: '已完成' },
  { key: 'widget', icon: 'widget', label: '小组件' }
]

/** 收起时宽度归零（CSS transition 平滑动画），内容 overflow hidden 防止溢出 */
export function Sidebar({ collapsed }: { collapsed?: boolean }): React.JSX.Element {
  const page = useAppStore((s) => s.page)
  const counts = useAppStore((s) => s.counts)
  const setPage = useAppStore((s) => s.setPage)

  const countFor = (key: NavDef['key']): { value: number; overdue?: boolean } => {
    if (!counts) return { value: 0 }
    switch (key) {
      case 'today':
        return { value: counts.todayCount, overdue: counts.overdueCount > 0 }
      case 'board':
        return { value: counts.boardCount }
      case 'upcoming':
        return { value: counts.upcomingCount }
      case 'all':
        return { value: counts.allCount }
      case 'completed':
        return { value: counts.completedCount }
      case 'search':
        return { value: 0 }
      case 'widget':
        return { value: 0 }
    }
  }

  return (
    <nav className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-brand">TodoList</div>

      {NAV.map((item) => {
        const { value, overdue } = countFor(item.key)
        return (
          <button
            key={item.key}
            type="button"
            className={`nav-item${page === item.key ? ' is-active' : ''}`}
            onClick={() => setPage(item.key)}
          >
            <Icon name={item.icon} />
            <span className="nav-item-label">{item.label}</span>
            {value > 0 && (
              <span className={`nav-count${overdue ? ' is-overdue' : ''}`} title={overdue ? '有逾期任务' : undefined}>
                {value}
              </span>
            )}
          </button>
        )
      })}

      <div className="nav-spacer" />
      <div className="nav-divider" />

      <button
        type="button"
        className={`nav-item${page === 'settings' ? ' is-active' : ''}`}
        onClick={() => setPage('settings')}
      >
        <Icon name="gear" />
        <span className="nav-item-label">设置</span>
      </button>
    </nav>
  )
}
