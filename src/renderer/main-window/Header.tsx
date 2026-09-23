import { formatFullDateDotted, todayKey } from '@shared/date'
import type { CategorySummary } from '@shared/types'
import { useAppStore, type PageKey } from '@renderer/shared/store/appStore'

/**
 * 页面标题表。
 *
 * 「看板」页的标题刻意不叫「看板」—— 侧栏的选中态已经表达了「你在看板」，
 * 右侧再写一遍就是标题重复（《UI优化》§4）。看板三列本身就是「待办池 / 今日待完成 /
 * 今日已完成」，标题写「今天」才与内容层级一致。
 *
 * 「today」这个 PageKey 对应的页面已从单列列表改为月历（《TodoList-今天页面改为月历视图》），
 * UI 文案随之叫「日历」。PageKey 本身不改：深链 /?page=today、托盘入口与自动化截图
 * 都引用它，改名的迁移成本远大于收益。
 */
const TITLES: Record<PageKey, string> = {
  today: '日历',
  board: '今天',
  upcoming: '待办任务',
  all: '全部任务',
  completed: '已完成',
  search: '搜索',
  widget: '桌面小组件',
  settings: '设置'
}

function subtitle(
  page: PageKey,
  today: string,
  counts: CategorySummary | null,
  calendarSelected: string | null
): string {
  switch (page) {
    case 'today':
      // 跟随月历的选中日期（初始为今天），看哪个日期就显示哪个日期
      return formatFullDateDotted(calendarSelected ?? today)
    case 'board':
      return formatFullDateDotted(today)
    case 'upcoming':
      return counts ? `共 ${counts.upcomingCount} 项待办` : '未来到期的任务'
    case 'all':
      return counts ? `共 ${counts.allCount} 项未完成` : '所有未删除任务'
    case 'completed':
      return counts ? `共 ${counts.completedCount} 项已完成` : '已完成的任务'
    case 'search':
      return '搜索任务标题与备注'
    case 'widget':
      return '贴在桌面上的待办便签'
    case 'settings':
      return '本地数据与偏好'
  }
}

export function Header(): React.JSX.Element {
  const page = useAppStore((s) => s.page)
  const counts = useAppStore((s) => s.counts)
  const openCreator = useAppStore((s) => s.openCreator)
  const calendarSelected = useAppStore((s) => s.calendarSelected)
  const today = todayKey()

  // 「+ 添加任务」的默认截止日：只在日历页把选中日期（无选中则今天）传给编辑器；
  // 其他页面不传，保持「新建默认无日期」的原行为 —— 新增逻辑本身没动，只传了初始值
  const createDefaultDue = page === 'today' ? (calendarSelected ?? today) : undefined

  return (
    <header className="header">
      <div>
        <div className="header-title">{TITLES[page]}</div>
        <div className="header-sub">{subtitle(page, today, counts, calendarSelected)}</div>
      </div>
      {page !== 'settings' && (
        <div className="header-actions">
          {/* 打开完整编辑器，而不是把焦点丢给捕获条 ——
              用户点「添加任务」时往往就是要设日期/提醒，捕获条给不了这些字段 */}
          <button type="button" className="header-link" onClick={() => openCreator(createDefaultDue)}>
            + 添加任务
          </button>
        </div>
      )}
    </header>
  )
}
