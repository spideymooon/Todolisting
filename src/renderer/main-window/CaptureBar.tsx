import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureTarget } from '@shared/capture-parse'
import { parseCapture } from '@shared/capture-parse'
import { dateKeyLabel } from '@shared/date'
import { useAppStore, type PageKey } from '@renderer/shared/store/appStore'
import { Icon } from '@renderer/shared/components/Icon'

/**
 * 常驻捕获条（《01-UI设计规范》§3.4）
 *
 * 三条不能动的行为：
 *  1. 打开即聚焦 —— 光标默认就在里面，不需要点任何东西
 *  2. Enter 创建后**保持焦点**并清空，支持连续录入
 *  3. 解析结果**实时显示在 chip 上**，先看见再提交，绝不静默改落点
 */

/** 未提交草稿。放在模块级，这样切页面导致组件重挂载也不会丢 */
let draftCache = ''

type Flash = 'idle' | 'added' | 'error'

export function CaptureBar({
  autoFocus,
  page,
  onRequestFirstTask
}: {
  autoFocus: boolean
  page: PageKey
  onRequestFirstTask: () => void
}): React.JSX.Element {
  const capture = useAppStore((s) => s.capture)
  const focusNonce = useAppStore((s) => s.focusNonce)
  const settings = useAppStore((s) => s.settings)
  const setPage = useAppStore((s) => s.setPage)

  const [text, setText] = useState(draftCache)
  const [target, setTarget] = useState<CaptureTarget>(settings.captureDefaultTarget)
  const [flash, setFlash] = useState<Flash>('idle')
  const [busy, setBusy] = useState(false)
  /** 快捷键提示只在输入框拿到焦点时出现（《UI优化》§7）—— 没在用就没有存在价值 */
  const [focused, setFocused] = useState(false)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef(text)
  textRef.current = text
  const timerRef = useRef<number | null>(null)

  // chip 的预演结果：用渲染层的解析器算，跟主进程入库时用的是同一份代码
  const parsed = useMemo(() => parseCapture(text, { defaultTarget: target }), [text, target])

  const chipLabel = useMemo(() => {
    if (parsed.matchedDateText && parsed.dueDate) return dateKeyLabel(parsed.dueDate)
    return target === 'today' ? '今天' : '待办池'
  }, [parsed.matchedDateText, parsed.dueDate, target])

  useEffect(() => {
    draftCache = text
  }, [text])

  // 打开即聚焦：启动 / 快捷键唤起 / 切页面都聚焦；从弹层返回时不抢焦点（由 autoFocus 控制）
  useEffect(() => {
    if (!autoFocus) return
    const el = taRef.current
    if (!el) return
    el.focus()
    const len = textRef.current.length
    el.setSelectionRange(len, len)
  }, [autoFocus, page, focusNonce])

  // 自动增高：1 行 → 最多 3 行（72px）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`
  }, [text])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const flashOnce = (next: Flash): void => {
    setFlash(next)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setFlash('idle'), next === 'error' ? 2600 : 600)
  }

  const submit = async (): Promise<void> => {
    const raw = text.replace(/\s*\n\s*/g, ' ').trim()
    if (!raw || busy) return
    setBusy(true)
    const result = await capture(raw, target)
    setBusy(false)

    if (result.ok) {
      setText('')
      draftCache = ''
      flashOnce('added')
      // 光标留在原地，直接打下一条
      taRef.current?.focus()
    } else {
      // 失败时**不清空内容**，用户可以点 chip 重试
      flashOnce('error')
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (text) {
        setText('')
        draftCache = ''
      } else {
        taRef.current?.blur()
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      setTarget((t) => (t === 'today' ? 'pool' : 'today'))
      return
    }
    if (e.key === 'ArrowUp' && text.length === 0) {
      e.preventDefault()
      onRequestFirstTask()
    }
  }

  const showJumpBack = flash === 'added' && page !== 'today' && page !== 'board' && target === 'today'
  const chipClass = `capture-chip${flash === 'error' ? ' is-error' : ''}`

  return (
    <>
      <div
        className={`capture${autoFocus ? ' is-focused' : ''}${flash === 'error' ? ' is-error' : ''}`}
        onClick={() => taRef.current?.focus()}
      >
        <span className="capture-plus">
          <Icon name="plus" size={15} strokeWidth={1.6} />
        </span>

        <textarea
          ref={taRef}
          className="capture-input"
          rows={1}
          value={text}
          spellCheck={false}
          placeholder="记点什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />

        {flash === 'added' && (
          <span className="capture-feedback">
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2 6.4L4.6 9L10 3.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            已添加
          </span>
        )}

        {showJumpBack && (
          <button type="button" className="capture-jump" onClick={() => setPage('today')}>
            去日历看看
          </button>
        )}

        <button
          type="button"
          className={chipClass}
          title={
            flash === 'error'
              ? '保存失败，点击重试'
              : `落点：${chipLabel}　点击或按 Tab 切换`
          }
          onClick={(e) => {
            e.stopPropagation()
            if (flash === 'error') {
              void submit()
              return
            }
            setTarget((t) => (t === 'today' ? 'pool' : 'today'))
          }}
        >
          {flash === 'error' ? '保存失败 · 重试' : `→ ${chipLabel}${parsed.tags.length ? ` · ${parsed.tags.join(' ')}` : ''}`}
        </button>
      </div>

      {/* 提示条常驻占位（避免显隐时页面跳动），但只有聚焦时才填文字：
          没在用捕获条时，快捷键说明对用户是噪音（《UI优化》§7） */}
      <div className={`capture-hint${focused ? ' is-visible' : ''}`}>
        {!focused
          ? ''
          : text.trim()
            ? `标题「${parsed.title || text.trim()}」　Enter 创建 · Shift+Enter 换行 · Tab 切换`
            : 'Enter 创建 · Shift+Enter 换行 · Tab 切换'}
      </div>
    </>
  )
}
