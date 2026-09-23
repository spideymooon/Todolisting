import { useEffect, useRef, useState } from 'react'
import { formatFullDate, offsetKey } from '@shared/date'
import { describePlan, nextReminderAt, type ReminderTask } from '@shared/reminder-plan'
import {
  REPEAT_END_OPTIONS,
  REPEAT_FREQ_OPTIONS,
  REPEAT_UNIT_OPTIONS,
  WEEKDAY_LABELS,
  defaultRule,
  describeNextOccurrence,
  describeRule,
  describeRuleEnd,
  type RepeatFreq,
  type RepeatRule
} from '@shared/repeat'
import {
  REMINDER_DAY_PRESETS,
  type NotifyChannel,
  type Priority,
  type Task
} from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { PRIORITY_META, PRIORITY_ORDER } from '@renderer/shared/components/PriorityBadge'
import { Icon } from '@renderer/shared/components/Icon'

const TIME_PRESETS = ['09:00', '12:00', '20:00'] as const

function dayLabel(days: number): string {
  return days === 0 ? '当天' : `提前 ${days} 天`
}

/**
 * 给某个频率造一条规则。
 * weekly 默认勾上当前截止日的星期（§4「每周按当前截止日的星期几」），
 * 没选日期时兜底周一 —— 选了日期后服务层会再兜一次底。
 */
function makeRule(freq: RepeatFreq, dueDate: string | null): RepeatRule {
  return defaultRule(freq, dueDate)
}

/** 规则 + 结束条件的合并文案 */
function describeRuleLine(rule: RepeatRule): string {
  const base = describeRule(rule)
  const end = describeRuleEnd(rule)
  return end ? `${base}（${end}）` : base
}

/**
 * 任务编辑器（§16 的「编辑」、§3 的全部字段、§7 的通知方式）。
 *
 * 同一个组件承担两个模式：
 *   task 非 null → 编辑模式（保存 = update）
 *   task 为 null → 新建模式（保存 = create），「+ 添加任务」按钮与 ?edit=new 深链走这里
 *
 * 设计上有一条硬要求：**提醒时刻必须实时预览**。
 * 因为「提前 2 天 + 09:00」到底会在什么时候响，对用户是不透明的 ——
 * 尤其当算出来的时刻已经过去、系统会立刻补发一次时，用户更该事先知道。
 * 这与捕获条的 chip 是同一个原则：计算结果先看得见，再提交。
 */
export function TaskEditor({
  task,
  onClose
}: {
  task: Task | null
  onClose: () => void
}): React.JSX.Element {
  const updateTask = useAppStore((s) => s.updateTask)
  const createTask = useAppStore((s) => s.createTask)
  const remove = useAppStore((s) => s.remove)
  const settings = useAppStore((s) => s.settings)
  // 仅新建模式消费：日历页「+ 添加任务」带来的默认截止日（选中日期 / 今天）
  const creatorDefaultDate = useAppStore((s) => s.creatorDefaultDate)

  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 3)
  // 编辑模式一律带回任务自己的日期（哪怕为 null）—— 默认值只对新建生效
  const [dueDate, setDueDate] = useState<string | null>(task ? task.dueDate : creatorDefaultDate)
  const [dueTime, setDueTime] = useState(task?.dueTime ?? '')
  // 新建模式的提醒初值 = 全局默认（与主进程 create 的快照逻辑一致，预览才不会骗人）
  const [reminderEnabled, setReminderEnabled] = useState(
    task?.reminderEnabled ?? settings.defaultReminderEnabled
  )
  const [reminderDays, setReminderDays] = useState(task?.reminderDays ?? settings.defaultReminderDays)
  const [reminderTime, setReminderTime] = useState(task?.reminderTime || settings.defaultReminderTime)
  const [desktopOn, setDesktopOn] = useState(
    task
      ? task.notifyChannels === 'desktop' || task.notifyChannels === 'both'
      : settings.desktopNotifyEnabled
  )
  const [wechatOn, setWechatOn] = useState(
    task
      ? task.notifyChannels === 'wechat' || task.notifyChannels === 'both'
      : settings.wechatNotifyEnabled
  )
  const [tagText, setTagText] = useState(task?.tags.map((t) => t.name).join(' ') ?? '')
  /**
   * 重复规则。null = 不重复（默认，§3「默认只显示不重复」）。
   * 编辑模式下带回任务身上已有的规则。
   */
  const [repeatRule, setRepeatRule] = useState<RepeatRule | null>(task?.repeatRule ?? null)
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  const channels: NotifyChannel =
    desktopOn && wechatOn ? 'both' : desktopOn ? 'desktop' : wechatOn ? 'wechat' : 'none'

  // ── 实时预览：用的是主进程同一份 nextReminderAt（@shared/reminder-plan）──
  const now = new Date()
  const previewTask: ReminderTask = {
    title,
    status: task?.status ?? 'pending',
    dueDate,
    dueTime: dueTime || null,
    reminderEnabled,
    reminderDays,
    reminderTime,
    notifyChannels: channels
  }
  const plan = nextReminderAt(
    previewTask,
    {
      overduePolicy: settings.overduePolicy,
      desktopNotifyEnabled: settings.desktopNotifyEnabled,
      wechatNotifyEnabled: settings.wechatNotifyEnabled
    },
    now,
    task?.id ?? 'new'
  )

  // 重复规则的结果也要先看得见 —— 与提醒预览同一个原则
  const nextText = dueDate ? describeNextOccurrence(repeatRule, dueDate) : null

  const handleSave = async (): Promise<void> => {
    const trimmed = title.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const payload = {
        title: trimmed,
        note: note.trim() ? note.trim() : null,
        priority,
        dueDate,
        // 没有截止日期时不该留下孤立的时刻，否则会出现「无日期但 18:00 截止」的脏数据
        dueTime: dueDate ? dueTime || null : null,
        reminderEnabled,
        reminderDays,
        reminderTime,
        notifyChannels: channels,
        // 没有截止日就没有推进锚点，规则落库会被服务层降级为不重复 —— 这里先清掉，
        // 让「保存了什么」与「预览里说了什么」完全一致
        repeatRule: dueDate ? repeatRule : null,
        tags: tagText
          .split(/[\s,，]+/)
          .map((s) => s.replace(/^#/, '').trim())
          .filter(Boolean)
      }
      if (task) {
        await updateTask(task.id, payload)
      } else {
        await createTask(payload)
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!task) return
    await remove(task.id)
    onClose()
  }

  // 每次都重新绑定，这样回调里拿到的永远是最新的表单状态
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void handleSave()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{task ? '编辑任务' : '新建任务'}</div>
          <button type="button" className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <Icon name="close" size={14} strokeWidth={1.8} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <div className="field-label">任务</div>
            <input
              ref={titleRef}
              className="input"
              value={title}
              placeholder="要做什么……"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <div className="field-label">备注</div>
            <textarea
              className="textarea"
              value={note}
              placeholder="补充说明（可不填）"
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="field">
            <div className="field-label">优先级</div>
            <div className="chips">
              {PRIORITY_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`chip${priority === p ? ' is-active' : ''}`}
                  style={priority === p ? { color: PRIORITY_META[p].color, borderColor: PRIORITY_META[p].color } : undefined}
                  onClick={() => setPriority(p)}
                >
                  {PRIORITY_META[p].label} · {p === 1 ? '紧急' : p === 2 ? '重要' : '普通'}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="field-label">截止</div>
            <div className="field-split">
              <input
                type="date"
                className="input"
                value={dueDate ?? ''}
                onChange={(e) => setDueDate(e.target.value || null)}
              />
              <input
                type="time"
                className="input"
                value={dueTime}
                disabled={!dueDate}
                title={dueDate ? '可选' : '先选日期'}
                onChange={(e) => setDueTime(e.target.value)}
              />
            </div>
            <div className="chips">
              <button
                type="button"
                className="chip"
                onClick={() => setDueDate(offsetKey(now, 0))}
              >
                今天
              </button>
              <button type="button" className="chip" onClick={() => setDueDate(offsetKey(now, 1))}>
                明天
              </button>
              <button type="button" className="chip" onClick={() => setDueDate(offsetKey(now, 2))}>
                后天
              </button>
              <button type="button" className="chip" onClick={() => setDueDate(offsetKey(now, 7))}>
                一周后
              </button>
              {dueDate && (
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    setDueDate(null)
                    setDueTime('')
                  }}
                >
                  清除
                </button>
              )}
            </div>
            {dueDate && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {formatFullDate(dueDate)}
              </div>
            )}
          </div>

          {/* §2：字段顺序 截止 → 重复 → 提醒。§3：默认只显示「不重复」，选了才渐进展开 */}
          <div className="field">
            <div className="field-label">重复</div>
            <div className="chips">
              <button
                type="button"
                className={`chip${repeatRule === null ? ' is-active' : ''}`}
                onClick={() => setRepeatRule(null)}
              >
                不重复
              </button>
              {REPEAT_FREQ_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`chip${repeatRule?.freq === opt.value ? ' is-active' : ''}`}
                  onClick={() => setRepeatRule(makeRule(opt.value, dueDate))}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {!dueDate && repeatRule !== null && (
              <div style={{ fontSize: 12, color: 'var(--due-soon)' }}>
                重复需要截止日期作为推进基准，请先选一个日期
              </div>
            )}

            {repeatRule !== null && dueDate && (
              <>
                {/* custom：每 [N] [天/周/月] */}
                {repeatRule.freq === 'custom' && (
                  <div className="chips" style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>每</span>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      className="input"
                      style={{ width: 66, padding: '4px 8px', fontSize: 12 }}
                      value={repeatRule.interval}
                      onChange={(e) =>
                        setRepeatRule((r) =>
                          r ? { ...r, interval: Math.max(1, Number(e.target.value) || 1) } : r
                        )
                      }
                    />
                    {REPEAT_UNIT_OPTIONS.map((u) => (
                      <button
                        key={u.value}
                        type="button"
                        className={`chip${repeatRule.unit === u.value ? ' is-active' : ''}`}
                        onClick={() => setRepeatRule((r) => (r ? { ...r, unit: u.value } : r))}
                      >
                        {u.label}
                      </button>
                    ))}
                  </div>
                )}

                {/* weekly：多选星期，默认勾当前截止日的星期 */}
                {repeatRule.freq === 'weekly' && (
                  <div className="chips" style={{ marginTop: 4 }}>
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={`chip${repeatRule.weekdays.includes(idx) ? ' is-active' : ''}`}
                        onClick={() =>
                          setRepeatRule((r) => {
                            if (!r) return r
                            const has = r.weekdays.includes(idx)
                            // 至少留一个，否则规则会退化成「每周什么也不做」
                            if (has && r.weekdays.length === 1) return r
                            return {
                              ...r,
                              weekdays: has
                                ? r.weekdays.filter((d) => d !== idx)
                                : [...r.weekdays, idx].sort((a, b) => a - b)
                            }
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}

                {/* 结束条件。§5 默认「永不」 */}
                <div className="field-label" style={{ marginTop: 4 }}>
                  结束
                </div>
                <div className="chips">
                  {REPEAT_END_OPTIONS.map((e) => (
                    <button
                      key={e.value}
                      type="button"
                      className={`chip${repeatRule.endType === e.value ? ' is-active' : ''}`}
                      onClick={() =>
                        setRepeatRule((r) => {
                          if (!r) return r
                          if (e.value === 'until') {
                            // 没给日期时给个合理默认：当前截止日的 3 个月后
                            return { ...r, endType: 'until', endDate: r.endDate ?? offsetKey(now, 90) }
                          }
                          return { ...r, endType: e.value }
                        })
                      }
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
                {repeatRule.endType === 'until' && (
                  <input
                    type="date"
                    className="input"
                    style={{ marginTop: 4 }}
                    value={repeatRule.endDate ?? ''}
                    onChange={(e) =>
                      setRepeatRule((r) => (r ? { ...r, endDate: e.target.value || null } : r))
                    }
                  />
                )}
                {repeatRule.endType === 'count' && (
                  <div className="chips" style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>共</span>
                    <input
                      type="number"
                      min={2}
                      max={999}
                      className="input"
                      style={{ width: 66, padding: '4px 8px', fontSize: 12 }}
                      value={repeatRule.endCount}
                      onChange={(e) =>
                        setRepeatRule((r) =>
                          r ? { ...r, endCount: Math.max(2, Number(e.target.value) || 2) } : r
                        )
                      }
                    />
                    <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>次</span>
                  </div>
                )}

                {/* 结果先看得见：规则描述 + 下一次的日期。与提醒预览同一个原则 */}
                <div className="repeat-preview">
                  <Icon name="repeat" size={14} />
                  <span>{describeRuleLine(repeatRule)}</span>
                  {nextText && <span className="repeat-next">下次：{nextText}</span>}
                </div>
              </>
            )}
          </div>

          <div className="field">
            <div
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div className="field-label">提醒</div>
              <button
                type="button"
                className={`toggle${reminderEnabled ? ' is-on' : ''}`}
                title={reminderEnabled ? '关闭提醒' : '开启提醒'}
                onClick={() => setReminderEnabled((v) => !v)}
              />
            </div>

            {reminderEnabled && (
              <>
                <div className="chips" style={{ marginTop: 4 }}>
                  {REMINDER_DAY_PRESETS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`chip${reminderDays === d ? ' is-active' : ''}`}
                      onClick={() => setReminderDays(d)}
                    >
                      {dayLabel(d)}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={0}
                    max={60}
                    className="input"
                    style={{ width: 74, padding: '4px 8px', fontSize: 12 }}
                    value={reminderDays}
                    title="自定义提前天数"
                    onChange={(e) => setReminderDays(Math.max(0, Number(e.target.value) || 0))}
                  />
                </div>

                <div className="chips" style={{ marginTop: 4 }}>
                  {TIME_PRESETS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={`chip${reminderTime === t ? ' is-active' : ''}`}
                      onClick={() => setReminderTime(t)}
                    >
                      {t}
                    </button>
                  ))}
                  <input
                    type="time"
                    className="input"
                    style={{ width: 108, padding: '4px 8px', fontSize: 12 }}
                    value={reminderTime}
                    onChange={(e) => setReminderTime(e.target.value || '09:00')}
                  />
                </div>

                <div className="field-label" style={{ marginTop: 4 }}>
                  通知方式
                </div>
                <div className="chips">
                  <button
                    type="button"
                    className={`chip${desktopOn ? ' is-active' : ''}`}
                    onClick={() => setDesktopOn((v) => !v)}
                  >
                    桌面通知
                  </button>
                  <button
                    type="button"
                    className={`chip${wechatOn ? ' is-active' : ''}`}
                    onClick={() => setWechatOn((v) => !v)}
                  >
                    微信提醒
                  </button>
                </div>
                {wechatOn && !settings.wechatNotifyEnabled && (
                  <div style={{ fontSize: 12, color: 'var(--due-soon)' }}>
                    微信通道尚未接通（需要先在设置里配置 PushPlus Token）
                  </div>
                )}
              </>
            )}

            <ReminderPreview
              reminderEnabled={reminderEnabled}
              dueDate={dueDate}
              channels={channels}
              desktopGlobalOff={!settings.desktopNotifyEnabled}
              planText={plan ? describePlan(plan) : null}
              immediate={plan ? plan.reason !== 'scheduled' : false}
            />
          </div>

          <div className="field">
            <div className="field-label">标签</div>
            <input
              className="input"
              value={tagText}
              placeholder="空格分隔，例如：工作 汇报"
              onChange={(e) => setTagText(e.target.value)}
            />
          </div>
        </div>

        <div className="modal-foot">
          {task && (
            <button type="button" className="btn btn-danger" onClick={() => void handleDelete()}>
              删除
            </button>
          )}
          <div className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !title.trim()}
            onClick={() => void handleSave()}
          >
            {saving ? '保存中…' : task ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 提醒结果的显式呈现。宁可说「不会提醒」，也不让用户以为设好了 */
function ReminderPreview({
  reminderEnabled,
  dueDate,
  channels,
  desktopGlobalOff,
  planText,
  immediate
}: {
  reminderEnabled: boolean
  dueDate: string | null
  channels: NotifyChannel
  desktopGlobalOff: boolean
  planText: string | null
  immediate: boolean
}): React.JSX.Element {
  const base = 'remind-preview'
  const bell = <Icon name="bell" size={14} />

  if (!reminderEnabled) {
    return (
      <div className={`${base} is-off`} style={{ marginTop: 6 }}>
        <span className="remind-dot">{bell}</span>
        <span>提醒已关闭，这个任务不会发出通知</span>
      </div>
    )
  }
  if (!dueDate) {
    return (
      <div className={`${base} is-off`} style={{ marginTop: 6 }}>
        <span className="remind-dot">{bell}</span>
        <span>没有截止日期，提醒没有锚点 —— 选个日期才会提醒</span>
      </div>
    )
  }
  if (channels === 'none') {
    return (
      <div className={`${base} is-off`} style={{ marginTop: 6 }}>
        <span className="remind-dot">{bell}</span>
        <span>桌面通知与微信提醒都关着，不会发出提醒</span>
      </div>
    )
  }
  if (!planText) {
    return (
      <div className={`${base} is-off`} style={{ marginTop: 6 }}>
        <span className="remind-dot">{bell}</span>
        <span>
          不会提醒：任务已逾期
          {desktopGlobalOff ? '，且桌面通知在设置里被总开关关掉了' : '，按当前的逾期策略不再补提醒'}
        </span>
      </div>
    )
  }
  return (
    <div
      className={`${base}${immediate ? ' is-warn' : ''}`}
      style={{ marginTop: 6 }}
    >
      <span className={`remind-dot${immediate ? ' is-warn' : ''}`}>{bell}</span>
      <span>
        {immediate ? '' : '将于 '}
        {planText}
      </span>
    </div>
  )
}
