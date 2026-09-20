/**
 * SQLite 连接（node-sqlite3-wasm）
 *
 * 为什么是 WASM 而不是 better-sqlite3 —— 见《00-架构设计》§1：
 * 本机缺失 MSVC 链接器，任何需要 node-gyp 编译或按 Electron ABI rebuild 的原生模块都有
 * 构建风险。node-sqlite3-wasm 把 SQLite 编译成 WASM，**零原生编译**，同时提供真实的
 * `.sqlite` 文件读写与同步 API。
 *
 * 本文件**不 import 任何 Electron API** —— dbPath 由主进程注入（《00-架构设计》§2 设计要点）。
 */

import { Database } from 'node-sqlite3-wasm'

export type Db = Database

export interface OpenResult {
  db: Db
  path: string
  /** 本次是否新建了数据库文件（用于决定是否写入示例数据） */
  created: boolean
  pragmas: Record<string, string>
}

export function openDatabase(path: string, existedBefore: boolean): OpenResult {
  const db = new Database(path)

  // 注意：不启用 WAL。node-sqlite3-wasm 的 VFS 对共享内存/文件锁支持有限，
  // 桌面单进程场景用默认的回滚日志（rollback journal）足够。
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')

  const pragmas: Record<string, string> = {}
  for (const name of ['journal_mode', 'foreign_keys', 'user_version'] as const) {
    pragmas[name] = String(readPragma(db, name) ?? '')
  }

  return { db, path, created: !existedBefore, pragmas }
}

export function readPragma(db: Db, name: string): unknown {
  const row = db.get(`PRAGMA ${name};`) as Record<string, unknown> | undefined
  if (!row) return undefined
  return row[name] ?? Object.values(row)[0]
}

/**
 * 事务包装。node-sqlite3-wasm 是**同步** API，所以这里不需要 async ——
 * 也就天然不存在「事务跨 await 被切碎」的竞态。
 *
 * 看板拖拽的 `moveTask` 依赖这个包装：字段变更与提醒重算必须在同一事务里
 * （《00-架构设计》§13.2）。
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;')
  try {
    const result = fn()
    db.exec('COMMIT;')
    return result
  } catch (err) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // 回滚失败说明事务已经不在活动状态，忽略即可，原始错误更重要
    }
    throw err
  }
}
