import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, readPragma, type Db } from '../database/connection'
import { runMigrations } from '../database/migrate'
import { migrations } from '../database/migrations'
import { TaskService } from './task.service'
import { defaultRule } from '@shared/repeat'
import type { CreateTaskInput } from '@shared/types'

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
    // 003_repeat 之后是 3
    expect(Number(readPragma(db, 'user_version'))).toBe(3)
  })

  it('重复执行迁移是幂等的', () => {
    const again = runMigrations(db, migrations)
    expect(again.applied).toEqual([])
    expect(again.to).toBe(3)
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

  it('003 加上 repeat_rule 列，并复用 001 预留的 series_id', () => {
    const cols = (
      db.all('PRAGMA table_info(tasks)') as unknown as Array<{ name: string }>
    ).map((r) => r.name)

    expect(cols).toContain('repeat_rule')
    // 这两个是 001 就预留好的，003 只是开始真正使用它们
    expect(cols).toContain('series_id')
    expect(cols).toContain('is_template')

    const idx = (
      db.all("SELECT name FROM sqlite_master WHERE type='index'") as unknown as Array<{
        name: string
      }>
    ).map((r) => r.name)
    expect(idx).toContain('idx_tasks_series')
  })

  it('存量任务迁移后 repeat_rule 为 NULL（= 不重复）', () => {
    const task = service.create({ title: '老任务', dueDate: TODAY }, NOW)
    expect(task.repeatRule).toBeNull()
    expect(task.seriesId).toBeNull()
  })

  it('★ 从 v2 老库升级到 v3：既有数据一条不丢', () => {
    // 另起一个只跑到 002 的库，写入数据后再跑 003 —— 这才是真实用户的升级路径。
    // 老库用裸 SQL 塞数据：新的 insert 语句已经会写 repeat_rule 列，跑不了 v2 schema。
    const upgradeDir = mkdtempSync(join(tmpdir(), 'desktop-todo-upgrade-'))
    const { db: old } = openDatabase(join(upgradeDir, 'old.sqlite'), false)
    try {
      runMigrations(old, migrations.filter((m) => m.version <= 2))
      expect(Number(readPragma(old, 'user_version'))).toBe(2)

      old.run(
        `INSERT INTO tasks
           (id, title, note, status, priority, due_date, due_time, due_at_utc,
            reminder_enabled, reminder_days, reminder_time, notify_channels,
            sort_order, is_template, created_at, updated_at)
         VALUES ('old-1', '升级前的任务', NULL, 'pending', 3, ?, NULL, NULL,
                 1, 1, '09:00', 'desktop', 0, 0, ?, ?)`,
        [TODAY, NOW.toISOString(), NOW.toISOString()]
      )
      old.run(
        `INSERT INTO tasks
           (id, title, note, status, priority, due_date, due_time, due_at_utc,
            reminder_enabled, reminder_days, reminder_time, notify_channels,
            sort_order, is_template, created_at, updated_at, completed_at)
         VALUES ('old-2', '升级前已完成', NULL, 'completed', 3, ?, NULL, NULL,
                 1, 1, '09:00', 'desktop', 0, 0, ?, ?, ?)`,
        [TODAY, NOW.toISOString(), NOW.toISOString(), NOW.toISOString()]
      )
      // 一条老库里的软删除记录，升级后也该原样保留
      old.run(`UPDATE tasks SET deleted_at = ? WHERE id = 'old-2'`, [NOW.toISOString()])

      // ── 跑 003 ──
      const result = runMigrations(old, migrations)
      expect(result.from).toBe(2)
      expect(result.to).toBe(3)
      expect(result.applied).toEqual(['3_repeat'])

      const rows = old.all(
        'SELECT id, title, status, due_date, repeat_rule, series_id, deleted_at FROM tasks ORDER BY id'
      ) as unknown as Array<Record<string, unknown>>

      expect(rows).toHaveLength(2)
      expect(rows[0].title).toBe('升级前的任务')
      expect(rows[0].status).toBe('pending')
      expect(rows[0].due_date).toBe(TODAY)
      // 新列对存量数据全是 NULL —— 正是期望值，无需回填
      expect(rows[0].repeat_rule).toBeNull()
      expect(rows[0].series_id).toBeNull()
      // 软删除标记与已完成状态都没被破坏
      expect(rows[1].status).toBe('completed')
      expect(rows[1].deleted_at).toBe(NOW.toISOString())

      // 升级后服务层能正常读写
      const upgraded = new TaskService(old, () => undefined)
      expect(upgraded.list('all', NOW).map((t) => t.title)).toEqual(['升级前的任务'])
      const created = upgraded.create(
        { title: '升级后的重复任务', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
        NOW
      )
      expect(created.repeatRule?.freq).toBe('daily')
      expect(created.seriesId).toBe(created.id)
    } finally {
      old.close()
      rmSync(upgradeDir, { recursive: true, force: true })
    }
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

/**
 * 重复任务（《TodoList-重复任务功能》）。
 *
 * 核心行为（§6 / §7 / §8）：**规则 + 当前实例，绝不预生成未来任务**。
 * 只有当前实例被**完成**时才生成下一次，且生成必须幂等。
 */
describe('重复任务 —— 完成时生成下一次', () => {
  /** 建一条带重复规则、以 TODAY 为基准的任务 */
  function repeatTask(patch: Partial<CreateTaskInput> = {}) {
    return service.create(
      {
        title: '每日站会',
        dueDate: TODAY,
        dueTime: '09:00',
        repeatRule: { ...defaultRule('daily', TODAY) },
        ...patch
      },
      NOW
    )
  }

  it('不重复的任务创建后 repeatRule / seriesId 都是 null', () => {
    const task = service.create({ title: '一次性任务', dueDate: TODAY }, NOW)
    expect(task.repeatRule).toBeNull()
    expect(task.seriesId).toBeNull()
  })

  it('创建重复任务：规则被存下，seriesId = 自身 id', () => {
    const task = repeatTask()
    expect(task.repeatRule?.freq).toBe('daily')
    expect(task.seriesId).toBe(task.id)
  })

  it('★ 创建时**不**预生成任何未来实例（§6 的核心约束）', () => {
    repeatTask()
    const all = service.list('all', NOW)
    expect(all).toHaveLength(1)
    expect(all[0].dueDate).toBe(TODAY)
  })

  it('★ 完成后生成下一次，日期按规则推进', () => {
    const task = repeatTask()
    service.toggle(task.id, NOW)

    const all = service.list('all', NOW)
    const next = all.find((t) => t.status === 'pending')
    expect(next?.dueDate).toBe('2026-09-18')
    expect(next?.dueTime).toBe('09:00')
    expect(next?.title).toBe('每日站会')
  })

  it('下一次继承 seriesId，但 id 不同；规则里 doneCount + 1', () => {
    const task = repeatTask()
    service.toggle(task.id, NOW)

    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.id).not.toBe(task.id)
    expect(next?.seriesId).toBe(task.seriesId)
    expect(next?.repeatRule?.doneCount).toBe(2)
  })

  it('下一次继承标签', () => {
    const task = repeatTask({ tags: ['工作'] })
    service.toggle(task.id, NOW)

    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.tags.map((t) => t.name)).toEqual(['工作'])
  })

  it('下一次不是今天时**不**进「今日待完成」（§7）', () => {
    const task = repeatTask() // 下一次是 9-18
    service.toggle(task.id, NOW)

    const board = service.board(NOW)
    expect(board.todayPending).toHaveLength(0)
    // 它待在待办池里
    expect(board.pool.map((t) => t.dueDate)).toEqual(['2026-09-18'])
  })

  it('下一次正好是今天时立刻进「今日待完成」', () => {
    // 逾期两天 + 每天重复 → 下一次 = 9-16，仍 <= 今天
    const task = service.create(
      { title: '赶进度', dueDate: '2026-09-16', repeatRule: defaultRule('daily', '2026-09-16') },
      NOW
    )
    service.toggle(task.id, NOW)

    const board = service.board(NOW)
    expect(board.todayPending.map((t) => t.title)).toEqual(['赶进度'])
    expect(board.todayPending[0].dueDate).toBe('2026-09-17')
  })

  it('★ 工作日规则跨周末：周五完成 → 下周一', () => {
    const task = service.create(
      {
        title: '日报',
        dueDate: '2026-09-18', // 周五
        repeatRule: defaultRule('weekday', '2026-09-18')
      },
      NOW
    )
    service.toggle(task.id, NOW)

    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.dueDate).toBe('2026-09-21') // 周一
  })

  it('★ 每月 31 日的规则，2 月收敛到最后一天', () => {
    const jan31 = new Date(2026, 0, 31, 10, 0, 0)
    const task = service.create(
      { title: '结算', dueDate: '2026-01-31', repeatRule: defaultRule('monthly', '2026-01-31') },
      jan31
    )
    service.toggle(task.id, jan31)

    const next = service.list('all', jan31).find((t) => t.status === 'pending')
    expect(next?.dueDate).toBe('2026-02-28')
  })

  it('无截止日的任务即使带规则也不会生成下一次（没有推进锚点）', () => {
    const task = service.create(
      { title: '读书', repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    expect(task.repeatRule).toBeNull() // 落库时被降级为不重复
    service.toggle(task.id, NOW)
    expect(service.list('all', NOW)).toHaveLength(1)
  })
})

describe('重复任务 —— 幂等与防重复生成（§14）', () => {
  function makeRepeating() {
    return service.create(
      { title: '吃药', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
  }

  it('★ 快速连点完成：第二次 toggle 是「取消完成」，不会再多生成一条', () => {
    const task = makeRepeating()
    service.toggle(task.id, NOW) // pending → completed，生成 9-18
    service.toggle(task.id, NOW) // completed → pending，不该生成
    service.toggle(task.id, NOW) // pending → completed，但 9-18 已存在 → 跳过

    const all = service.list('all', NOW)
    expect(all.filter((t) => t.status === 'pending')).toHaveLength(1)
    expect(all).toHaveLength(2) // 老实例 + 一条后继
  })

  it('★ 取消勾选完成时，已生成的下一次**不**被删除', () => {
    const task = makeRepeating()
    service.toggle(task.id, NOW)
    const nextId = service.list('all', NOW).find((t) => t.status === 'pending')?.id

    service.toggle(task.id, NOW) // 取消完成

    const next = service.list('all', NOW).find((t) => t.id === nextId)
    expect(next).toBeDefined()
    expect(next?.status).toBe('pending')
  })

  it('★ 重启后重跑一遍完成逻辑不会重复生成（幂等键 = series_id + due_date）', () => {
    const task = makeRepeating()
    service.toggle(task.id, NOW)
    const before = service.list('all', NOW).map((t) => t.dueDate).sort()

    // 模拟「进程重启后又点了一次完成」：把状态强行改回 pending，再完成一次
    db.run(`UPDATE tasks SET status='pending', completed_at=NULL WHERE id=?`, [task.id])
    service.toggle(task.id, NOW)

    const after = service.list('all', NOW).map((t) => t.dueDate).sort()
    expect(after).toEqual(before)
    expect(after).toHaveLength(2)
  })

  it('两个不同系列互不干扰', () => {
    const a = service.create(
      { title: 'A', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    const b = service.create(
      { title: 'B', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    service.toggle(a.id, NOW)
    service.toggle(b.id, NOW)

    const pending = service.list('all', NOW).filter((t) => t.status === 'pending')
    expect(pending.map((t) => t.title).sort()).toEqual(['A', 'B'])
    expect(a.seriesId).not.toBe(b.seriesId)
  })

  it('拖拽到「今日已完成」与勾选完成语义等价，同样生成下一次', () => {
    const task = makeRepeating()
    service.moveTask(task.id, 'todayDone', NOW)

    const pending = service.list('all', NOW).filter((t) => t.status === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0].dueDate).toBe('2026-09-18')
  })

  it('已经在「今日已完成」的任务再次拖入不会重复生成', () => {
    const task = makeRepeating()
    service.moveTask(task.id, 'todayDone', NOW)
    service.moveTask(task.id, 'todayDone', NOW)

    expect(service.list('all', NOW)).toHaveLength(2)
  })
})

describe('重复任务 —— 历史记录必须完整保留（§8 / §13）', () => {
  it('★ 完成三次后，三条历史都还在「已完成」里，且各自 due_date 正确', () => {
    let cursor: string | null = TODAY
    let currentId: string | null = null

    const first = service.create(
      { title: '晨跑', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    currentId = first.id

    // 连完三次
    for (let i = 0; i < 3; i++) {
      const before = service.list('all', NOW)
      service.toggle(currentId as string, NOW)
      const after = service.list('all', NOW)
      const next = after.find((t) => t.status === 'pending' && !before.some((b) => b.id === t.id))
      if (!next) break
      currentId = next.id
      cursor = next.dueDate
    }

    // 三条已完成 + 一条待完成
    const completed = service.list('completed', NOW)
    expect(completed).toHaveLength(3)
    expect(service.list('all', NOW).filter((t) => t.status === 'pending')).toHaveLength(1)

    // 每次历史各自的 due_date 不同、彼此不覆盖
    expect(completed.map((t) => t.dueDate).sort()).toEqual(['2026-09-17', '2026-09-18', '2026-09-19'])
    expect(cursor).toBe('2026-09-20')

    // 历史实例身上仍留着当时的规则快照（供「已完成」页回显）
    expect(completed.every((t) => t.repeatRule !== null)).toBe(true)
  })

  it('重复任务的已完成实例身上留着 seriesId，可按系列回溯', () => {
    const first = service.create(
      { title: 'weekly', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    service.toggle(first.id, NOW)

    const completed = service.list('completed', NOW)
    expect(completed).toHaveLength(1)
    expect(completed.every((t) => t.seriesId === first.id)).toBe(true)
  })
})

describe('重复任务 —— 结束条件', () => {
  it('until：超过指定日期就不再生成', () => {
    const task = service.create(
      {
        title: '限时打卡',
        dueDate: TODAY,
        repeatRule: { ...defaultRule('daily', TODAY), endType: 'until', endDate: '2026-09-18' }
      },
      NOW
    )
    service.toggle(task.id, NOW) // 生成 9-18
    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.dueDate).toBe('2026-09-18')

    service.toggle(next!.id, NOW) // 9-19 超过 endDate → 不再生成
    expect(service.list('all', NOW).filter((t) => t.status === 'pending')).toHaveLength(0)
    expect(service.list('completed', NOW)).toHaveLength(2)
  })

  it('count：达到次数后停止', () => {
    const task = service.create(
      {
        title: '三次复诊',
        dueDate: TODAY,
        repeatRule: { ...defaultRule('daily', TODAY), endType: 'count', endCount: 3 }
      },
      NOW
    )
    service.toggle(task.id, NOW) // 1 → 2
    const second = service.list('all', NOW).find((t) => t.status === 'pending')
    service.toggle(second!.id, NOW) // 2 → 3
    const third = service.list('all', NOW).find((t) => t.status === 'pending')
    // 第三次完成时 doneCount 已经到 3 → 不再生成
    service.toggle(third!.id, NOW)

    expect(service.list('completed', NOW)).toHaveLength(3)
    expect(service.list('all', NOW).filter((t) => t.status === 'pending')).toHaveLength(0)
  })
})

describe('重复任务 —— 编辑（§10）', () => {
  it('创建后再追加重复规则：补上 series_id', () => {
    const task = service.create({ title: '临时', dueDate: TODAY }, NOW)
    expect(task.seriesId).toBeNull()

    const updated = service.update(task.id, { repeatRule: defaultRule('daily', TODAY) }, NOW)
    expect(updated?.repeatRule?.freq).toBe('daily')
    expect(updated?.seriesId).toBe(task.id)
  })

  it('取消重复规则：repeatRule 变 null，但不抹掉已有 series_id', () => {
    const task = service.create(
      { title: '每周会', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    const updated = service.update(task.id, { repeatRule: null }, NOW)
    expect(updated?.repeatRule).toBeNull()
    // 历史串联系保留，否则已生成的后继实例会变成孤儿
    expect(updated?.seriesId).toBe(task.id)
  })

  it('★ 改规则不改动历史已完成实例', () => {
    const first = service.create(
      { title: '站会', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    service.toggle(first.id, NOW) // 生成 9-18，规则是「每天」
    const next = service.list('all', NOW).find((t) => t.status === 'pending')

    // 把当前活跃实例改成「每周」
    service.update(next!.id, { repeatRule: { ...defaultRule('weekly', next!.dueDate), weekdays: [5] } }, NOW)

    // 历史实例的规则快照原样是「每天」
    const done = service.list('completed', NOW)
    expect(done[0].repeatRule?.freq).toBe('daily')
    // 当前实例变成「每周五」
    const refreshed = service.list('all', NOW).find((t) => t.id === next!.id)
    expect(refreshed?.repeatRule?.freq).toBe('weekly')
  })

  it('weekly 规则不指定星期时，按当前截止日的星期补上', () => {
    // 2026-09-17 是周四 = 4。刻意把 weekdays 清空，验证服务层的兜底
    const task = service.create(
      {
        title: '周会',
        dueDate: TODAY,
        repeatRule: { ...defaultRule('weekly'), weekdays: [] }
      },
      NOW
    )
    expect(task.repeatRule?.weekdays).toEqual([4])
  })

  it('改截止日会同时更新规则推进基准（§10 第一版默认行为）', () => {
    const task = service.create(
      { title: '缴费', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    service.update(task.id, { dueDate: '2026-09-25' }, NOW)
    service.toggle(task.id, NOW)

    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.dueDate).toBe('2026-09-26')
  })
})

describe('重复任务 —— 与提醒系统联动（§9）', () => {
  it('★ 生成的下一次会各自触发一次 replan（每周都要提醒）', () => {
    const task = service.create(
      { title: '周报', dueDate: TODAY, repeatRule: defaultRule('daily', TODAY) },
      NOW
    )
    replan.mockClear()

    service.toggle(task.id, NOW)

    // 老实例一次（清理未发提醒）+ 新实例一次（排上提醒）
    expect(replan).toHaveBeenCalledWith(task.id)
    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(replan).toHaveBeenCalledWith(next!.id)
    expect(replan).toHaveBeenCalledTimes(2)
  })

  it('不重复的任务完成时只 replan 一次（不引入额外开销）', () => {
    const task = service.create({ title: '一次性', dueDate: TODAY }, NOW)
    replan.mockClear()
    service.toggle(task.id, NOW)
    expect(replan).toHaveBeenCalledTimes(1)
  })

  it('下一次带回原任务的提醒设置（提前天数 / 时刻 / 通道）', () => {
    const task = service.create(
      {
        title: '周会提醒',
        dueDate: TODAY,
        reminderEnabled: true,
        reminderDays: 2,
        reminderTime: '08:30',
        notifyChannels: 'both',
        repeatRule: defaultRule('daily', TODAY)
      },
      NOW
    )
    service.toggle(task.id, NOW)

    const next = service.list('all', NOW).find((t) => t.status === 'pending')
    expect(next?.reminderEnabled).toBe(true)
    expect(next?.reminderDays).toBe(2)
    expect(next?.reminderTime).toBe('08:30')
    expect(next?.notifyChannels).toBe('both')
  })
})

