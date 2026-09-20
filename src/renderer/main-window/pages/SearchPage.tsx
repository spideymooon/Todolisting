import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { useAppStore } from '@renderer/shared/store/appStore'
import { TaskRow } from '../task/TaskRow'

/**
 * 全局搜索页（标题栏放大镜入口）。
 *
 * 搜索走主进程 SQL LIKE（title + note），未完成在前、按更新时间倒序。
 * 输入 200ms 防抖后才发查询，避免每敲一个字符就打一次 SQLite。
 * 点结果直接打开编辑器 —— 搜索页只负责「找到并跳过去」。
 */
export function SearchPage(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Task[] | null>(null)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const toggle = useAppStore((s) => s.toggle)
  const remove = useAppStore((s) => s.remove)
  const openEditor = useAppStore((s) => s.openEditor)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void window.api.task.search(q).then((tasks) => {
        setResults(tasks)
        setSearching(false)
      })
    }, 200)
    return () => clearTimeout(timer)
  }, [query])

  return (
    <div className="search-page">
      <div className="search-box">
        <svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7.4 7.4l3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="搜索任务标题、备注…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button type="button" className="search-clear" title="清空" onClick={() => setQuery('')}>
            ×
          </button>
        )}
      </div>

      <div className="list">
        {!query.trim() && <div className="empty">输入关键词搜索所有任务（含已完成）</div>}
        {query.trim() && searching && results === null && (
          <div className="empty">搜索中…</div>
        )}
        {query.trim() && results !== null && results.length === 0 && (
          <div className="empty">没有匹配「{query.trim()}」的任务</div>
        )}
        {results?.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            flash={false}
            onToggle={() => void toggle(task.id)}
            onEdit={() => openEditor(task)}
            onRemove={() => void remove(task.id)}
          />
        ))}
      </div>
    </div>
  )
}
