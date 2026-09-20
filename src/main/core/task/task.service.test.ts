import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, readPragma, type Db } from '../database/connection'
import { runMigrations } from '../database/migrate'
import { migrations } from '../database/migrations'
import { TaskService } from './task.service'

/** 2026-09-17 周四 */
const NOW = new Date(2026, 8, 17, 10, 0, 0)
const TODAY = '2026-09-17'

let dir: string
let db: Db
let replan: ReturnType<typeof vi.fn>
let service: TaskService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'desktop-todo-'))
  const { db: opened } = openDatabase(join(dir, 'test.sqlite'), false)
  db = opened
  runMigrations(db, migrations)
  replan = vi.fn()
  service = new TaskService(db, replan)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('数据库与迁移', () => {
  it('建出全部表并把 user_version 推到最新', () => {
    const tables = (
      db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") as unknown as Array<{
        name: string
      }>
    ).map((r) => r.name)

    for (const t of ['tasks', 'tags', 'task_tags', 'settings', 'widgets', 'notification_logs']) {
      expect(tables).toContain(t)
    }
    // 002_reminder 之后是 2
    expect(Number(readPragma(db, 'user_version'))).toBe(2)
  })

  it('重复执行迁移是幂等的', () => {
    const again = runMigrations(db, migrations)
    expect(again.applied).toEqual([])
    expect(again.to).toBe(2)
  })

  it('002 把提醒字段补齐，并退役旧的 remind_advance_minutes', () => {
    const cols = (
      db.all('PRAGMA table_info(tasks)') as unknown as Array<{ name: string }>
    ).map((r) => r.name)

    for (const c of ['reminder_enabled', 'reminder_days', 'reminder_time', 'notify_channels']) {
      expect(cols).toContain(c)
    }
    expect(cols).not.toContain('remind_advance_minutes')

    // notification_logs 的 status CHECK 必须包含 replan 需要的 cancelled
    const ddl = (
      db.get("SELECT sql FROM sqlite_master WHERE name='notification_logs'") as unknown as {
        sql: string
      }
    ).sql
    expect(ddl).toContain('cancelled')
    expect(ddl).toContain('planned')
  })
})

describe('捕获条 → 看板三列', () => {
  it('没写日期时落到今天，并出现在「今日待完成」', () => {
    const result = service.capture('交周报', 'today', NOW)
    expect(result.ok).toBe(true)
    expect(result.task?.dueDate).toBe(TODAY)

    const board = service.board(NOW)
    expect(board.todayPending.map((t) => t.title)).toContain('交周报')
  })

  it('「明天」的任务落在待办池，不会从看板上消失', () => {
    // 回归：原设计里 pool 只收无日期任务，「明天」的任务会三列都进不去
    const result = service.capture('明天 交周报', 'today', NOW)
    expect(result.task?.dueDate).toBe('2026-09-18')
    expect(result.task?.title).toBe('交周报')

    const board = service.board(NOW)
    expect(board.pool.map((t) => t.title)).toContain('交周报')
    expect(board.todayPending).toHaveLength(0)
  })

  it('落点设为待办池时不写日期', () => {
    const result = service.capture('读会儿书', 'pool', NOW)
    expect(result.task?.dueDate).toBeNull()
    expect(service.board(NOW).pool.map((t) => t.title)).toEqual(['读会儿书'])
  })

  it('#标签 会自动建标签并绑定', () => {
    service.capture('后天 体检 #生活 #健康', 'today', NOW)
    const board = service.board(NOW)
    const task = board.pool.find((t) => t.title === '体检')
    expect(task?.tags.map((t) => t.name).sort()).toEqual(['健康', '生活'])
    expect(service.listTags().map((t) => t.name).sort()).toEqual(['健康', '生活'])
  })

  it('逾期任务浮到「今日待完成」列顶部', () => {
    service.create({ title: '今天到期的', dueDate: TODAY }, NOW)
    service.create({ title: '前两天就该做的', dueDate: '2026-09-15' }, NOW)

    const board = service.board(NOW)
    expect(board.todayPending.map((t) => t.title)).toEqual(['前两天就该做的', '今天到期的'])
  })

  it('标题里的日期词会被剥掉（这是设计行为，不是 bug）', () => {
    const result = service.capture('今天到期的', 'today', NOW)
    expect(result.task?.title).toBe('到期的')
  })

  it('空内容不创建任务', () => {
    expect(service.capture('   ', 'today', NOW).ok).toBe(false)
  })
})

describe('moveTask —— 看板拖拽的原子操作', () => {
  it('拖到「今日已完成」= status completed + 记录完成时刻', () => {
    const task = service.create({ title: '整理会议记录', dueDate: TODAY }, NOW)
    const moved = service.moveTask(task.id, 'todayDone', NOW)

    expect(moved?.status).toBe('completed')
    expect(moved?.completedAt).toBe(NOW.toISOString())
    expect(service.board(NOW).todayDone.map((t) => t.title)).toEqual(['整理会议记录'])
  })

  it('从「今日已完成」拖回来 = status pending + 清空完成时刻', () => {
    const task = service.create({ title: '写方案', dueDate: TODAY }, NOW)
    service.moveTask(task.id, 'todayDone', NOW)
    const back = service.moveTask(task.id, 'todayPending', NOW)

    expect(back?.status).toBe('pending')
    expect(back?.completedAt).toBeNull()
    expect(service.board(NOW).todayPending.map((t) => t.title)).toEqual(['写方案'])
  })

  it('拖回待办池 = due_date 清空（取消提醒锚点）', () => {
    const task = service.create({ title: '买咖啡豆', dueDate: TODAY }, NOW)
    const moved = service.moveTask(task.id, 'pool', NOW)

    expect(moved?.dueDate).toBeNull()
    expect(moved?.dueAtUtc).toBeNull()
    expect(service.board(NOW).pool.map((t) => t.title)).toEqual(['买咖啡豆'])
  })

  it('逾期任务拖进「今日待完成」会被重新安排到今天', () => {
    const task = service.create({ title: '补交报销单', dueDate: '2026-09-10' }, NOW)
    const moved = service.moveTask(task.id, 'todayPending', NOW)
    expect(moved?.dueDate).toBe(TODAY)
  })

  it('每次 moveTask 都在同一事务里触发一次 replan', () => {
    const task = service.create({ title: '任意任务', dueDate: TODAY }, NOW)
    replan.mockClear()

    service.moveTask(task.id, 'todayDone', NOW)
    expect(replan).toHaveBeenCalledTimes(1)
    expect(replan).toHaveBeenCalledWith(task.id)
  })

  it('拖拽到不存在的任务不会抛错', () => {
    expect(service.moveTask('不存在的id', 'todayDone', NOW)).toBeNull()
  })
})

describe('勾选 / 编辑 / 删除', () => {
  it('toggle 在 pending 与 completed 之间来回切换', () => {
    const task = service.create({ title: '背英语单词', dueDate: TODAY }, NOW)

    expect(service.toggle(task.id, NOW)?.status).toBe('completed')
    expect(service.board(NOW).todayDone).toHaveLength(1)

    expect(service.toggle(task.id, NOW)?.status).toBe('pending')
    expect(service.board(NOW).todayDone).toHaveLength(0)
  })

  it('改日期会同步重算 due_at_utc', () => {
    const task = service.create({ title: '开会', dueDate: TODAY }, NOW)
    const updated = service.update(task.id, { dueDate: '2026-09-20', dueTime: '14:30' }, NOW)

    expect(updated?.dueDate).toBe('2026-09-20')
    expect(updated?.dueTime).toBe('14:30')
    expect(updated?.dueAtUtc).toBe(new Date(2026, 8, 20, 14, 30, 0, 0).toISOString())
  })

  it('替换标签会先解绑旧的', () => {
    const task = service.create({ title: '测试', dueDate: TODAY, tags: ['工作'] }, NOW)
    const updated = service.update(task.id, { tags: ['生活'] }, NOW)

    expect(updated?.tags.map((t) => t.name)).toEqual(['生活'])
    // 标签本身保留在标签表里，方便复用
    expect(service.listTags().map((t) => t.name).sort()).toEqual(['工作', '生活'])
  })

  it('删除是软删除，不再出现在任何列或列表里', () => {
    const task = service.create({ title: '待删除', dueDate: TODAY }, NOW)
    expect(service.remove(task.id, NOW)).toBe(true)

    const board = service.board(NOW)
    expect([...board.pool, ...board.todayPending, ...board.todayDone]).toHaveLength(0)
    expect(service.list('all', NOW)).toHaveLength(0)
    expect(service.counts(NOW).allCount).toBe(0)
  })

  it('重复删除返回 false', () => {
    const task = service.create({ title: 'x', dueDate: TODAY }, NOW)
    service.remove(task.id, NOW)
    expect(service.remove(task.id, NOW)).toBe(false)
  })
})

describe('侧栏计数', () => {
  it('逾期数单独统计，今天数包含逾期', () => {
    service.create({ title: '逾期1', dueDate: '2026-09-15' }, NOW)
    service.create({ title: '逾期2', dueDate: '2026-09-16' }, NOW)
    service.create({ title: '今天', dueDate: TODAY }, NOW)
    service.create({ title: '明天', dueDate: '2026-09-18' }, NOW)
    service.create({ title: '无日期' }, NOW)

    const c = service.counts(NOW)
    expect(c.todayCount).toBe(3)
    expect(c.overdueCount).toBe(2)
    expect(c.upcomingCount).toBe(1)
    expect(c.allCount).toBe(5)
    // 看板 = 待办池 + 今日待完成 = 3（无日期 + 明天 + 2 逾期 + 今天）
    expect(c.boardCount).toBe(5)
    expect(c.completedCount).toBe(0)
  })
})

describe('列表作用域', () => {
  /**
   * 这一组是「小组件空列表」bug 的回归测试（§14.4）。
   *
   * 起因：widgetStore 曾用 `upcoming` 取数，而 `upcoming` 的 SQL 是
   * `due_date > today` —— 今天和逾期全被排除，小组件永远显示「最近三天没有待办」。
   * 所以这里必须把「今天/逾期算不算在内」钉死，防止以后有人改回去。
   */
  beforeEach(() => {
    service.create({ title: '逾期', dueDate: '2026-09-15' }, NOW)
    service.create({ title: '今天', dueDate: TODAY }, NOW)
    service.create({ title: '明天', dueDate: '2026-09-18' }, NOW)
    service.create({ title: '后天', dueDate: '2026-09-19' }, NOW)
    // 窗口外：第 3 天和第 4 天之后，都不该出现在小组件里
    service.create({ title: '大后天', dueDate: '2026-09-20' }, NOW)
    service.create({ title: '下个月', dueDate: '2026-10-17' }, NOW)
    service.create({ title: '无日期' }, NOW)
  })

  it('upcoming 只含「今天之后」，不含今天与逾期', () => {
    expect(service.list('upcoming', NOW).map((t) => t.title)).toEqual([
      '明天',
      '后天',
      '大后天',
      '下个月'
    ])
  })

  it('window = 逾期 + 今天 + 明天 + 后天，且逾期排最前', () => {
    const titles = service.list('window', NOW).map((t) => t.title)
    expect(titles).toEqual(['逾期', '今天', '明天', '后天'])
  })

  it('window 不含已完成、不含无日期、不含窗口外任务', () => {
    const titles = service.list('window', NOW).map((t) => t.title)
    expect(titles).not.toContain('大后天')
    expect(titles).not.toContain('下个月')
    expect(titles).not.toContain('无日期')

    const done = service.create({ title: '已完成的今天任务', dueDate: TODAY }, NOW)
    service.toggle(done.id, NOW)
    expect(service.list('window', NOW).map((t) => t.title)).not.toContain('已完成的今天任务')
  })

  it('window 按时刻升序，无时刻的排在当天有时刻的之后', () => {
    service.create({ title: '今天下午', dueDate: TODAY, dueTime: '14:00' }, NOW)
    service.create({ title: '今天上午', dueDate: TODAY, dueTime: '09:00' }, NOW)
    const todayTitles = service
      .list('window', NOW)
      .filter((t) => t.dueDate === TODAY)
      .map((t) => t.title)
    // 今天原有那条没有时刻 → 排在两条有时刻的后面
    expect(todayTitles).toEqual(['今天上午', '今天下午', '今天'])
  })

  it('窗口边界随 now 漂移 —— 明天再看，「后天」就变成「今天」了', () => {
    const nextDay = new Date(2026, 8, 18, 10, 0, 0)
    // 9-20 在前一天属于窗口外，到了 9-18 就落进「后天」这一格
    expect(service.list('window', nextDay).map((t) => t.title)).toEqual([
      '逾期',
      '今天',
      '明天',
      '后天',
      '大后天'
    ])
  })
})

describe('search —— 工具栏放大镜的全局搜索', () => {
  it('命中标题与备注，未完成排在已完成前面', () => {
    service.create({ title: '买牛奶', note: '顺便取快递' }, NOW)
    const done = service.create({ title: '牛奶咖啡计划' }, NOW)
    service.toggle(done.id, NOW)
    const hits = service.search('牛奶')
    expect(hits.map((t) => t.title)).toEqual(['买牛奶', '牛奶咖啡计划'])
    // 备注也能命中
    expect(service.search('快递').map((t) => t.title)).toEqual(['买牛奶'])
  })

  it('空查询返回空数组；LIKE 通配符被转义不会全表命中', () => {
    expect(service.search('')).toEqual([])
    expect(service.search('   ')).toEqual([])
    // 用户输入 % 不会变成「匹配一切」
    expect(service.search('%')).toEqual([])
    expect(service.search('_')).toEqual([])
  })
})
