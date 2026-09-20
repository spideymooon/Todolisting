/**
 * 版本化迁移执行器。
 *
 * 用 SQLite 内置的 `PRAGMA user_version` 记录当前版本，不额外建 migrations 表 ——
 * 少一张表，且 user_version 是原子的、跟数据库文件本身一起走。
 */

import { inTransaction, readPragma, type Db } from './connection'

export interface Migration {
  version: number
  name: string
  up: (db: Db) => void
}

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

export function currentVersion(db: Db): number {
  const raw = readPragma(db, 'user_version')
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

export function runMigrations(db: Db, migrations: Migration[]): MigrationResult {
  const from = currentVersion(db)
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > from)

  const applied: string[] = []

  for (const m of pending) {
    inTransaction(db, () => {
      m.up(db)
      // user_version 不支持参数绑定，version 来自我们自己的常量，不存在注入面
      db.exec(`PRAGMA user_version = ${Math.floor(m.version)};`)
    })
    applied.push(`${m.version}_${m.name}`)
  }

  return { from, to: currentVersion(db), applied }
}
