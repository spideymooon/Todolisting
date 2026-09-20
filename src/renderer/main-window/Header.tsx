import { formatFullDateDotted, todayKey } from '@shared/date'
import type { CategorySummary } from '@shared/types'
import { useAppStore, type PageKey } from '@renderer/shared/store/appStore'

/**
 * 页面标题表。
 *
 * 「看板」页的标题刻意不叫「看板」—— 侧栏的选中态已经表达了「你在看板」，
 * 右侧再写一遍就是标题重复（《UI优化》§4）。看板三列本身就是「待办池 / 今日待完成 /
 * 今日已完成」，标题写「今天」才与内容层级一致。
 */
const TITLES: Record<PageKey, string> = {
  today: '今天',
  board: '今天',
  upcoming: '即将到期',
  all: '全部任务',
  completed: '已完成',
  search: '搜索',
  widget: '桌面小组件',
  settings: '设置'
}

function subtitle(page: PageKey, today: string, counts: CategorySummary | null): string {
  switch (page) {
    case 'today':
    case 'board':
      return formatFullDateDotted(today)
    case 'upcoming':
      return counts ? `${counts.upcomingCount} 项在未来到期` : '未来到期的任务'
    case 'all':
      return counts ? `共 ${counts.allCount} 项未完成` : '所有未删除任务'
    case 'completed':
      return counts ? `共 ${counts.completedCount} 项已完成` : '已完成的任务'
    case 'search':
      return '搜索任务标题与备注'
    case 'widget':
      return '贴在桌面上的最近待办'
    case 'settings':
      return '本地数据与偏好'
  }
}

export function Header(): React.JSX.Element {
  const page = useAppStore((s) => s.page)
  const counts = useAppStore((s) => s.counts)
  const openCreator = useAppStore((s) => s.openCreator)
  const today = todayKey()

  return (
    <header className="header">
      <div>
        <div className="header-title">{TITLES[page]}</div>
        <div className="header-sub">{subtitle(page, today, counts)}</div>
      </div>
      {page !== 'settings' && (
        <div className="header-actions">
          {/* 打开完整编辑器，而不是把焦点丢给捕获条 ——
              用户点「添加任务」时往往就是要设日期/提醒，捕获条给不了这些字段 */}
          <button type="button" className="header-link" onClick={openCreator}>
            + 添加任务
          </button>
        </div>
      )}
    </header>
  )
}
