/**
 * 数据库存储位置。
 *
 * 需求：设置页「数据文件」支持「更改目录」。难点是「自定义目录」这个配置本身
 * 不能存在数据库里 —— 换目录后 DB 就不在老地方了，得有个 DB 之外的落点。
 * 所以用一个极小的 JSON 配置文件放在 userData（永远在默认位置）：
 *
 *   %APPDATA%/desktop-todo/db-location.json  →  { "dbDir": "D:/todo-data" }
 *
 * 文件不存在 / 解析失败 / 字段非法 → 一律回落默认位置（userData 本身）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const CONFIG_FILE = 'db-location.json'

/** SQLite 运行时可能产生的伴生文件（回滚日志模式只有 -journal，稳妥起见都覆盖） */
const SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm']

export function readCustomDbDir(userData: string): string | null {
  try {
    const file = join(userData, CONFIG_FILE)
    if (!existsSync(file)) return null
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as Record<string, unknown>)['dbDir'] === 'string'
    ) {
      const dir = (raw as Record<string, string>)['dbDir']
      return dir.trim() ? dir : null
    }
    return null
  } catch {
    return null
  }
}

export function writeCustomDbDir(userData: string, dir: string): void {
  writeFileSync(join(userData, CONFIG_FILE), JSON.stringify({ dbDir: dir }, null, 2), 'utf-8')
}

/**
 * 把数据库文件迁移到新目录（调用方先 db.close()，这里只搬文件）。
 * 目标目录不存在则创建；同名文件被覆盖 —— 目录是用户刚选的，覆盖是预期行为。
 */
export function migrateDbFile(oldPath: string, newDir: string): void {
  mkdirSync(newDir, { recursive: true })
  const dbName = oldPath.replace(/\\/g, '/').split('/').pop() ?? 'todo.sqlite'
  copyFileSync(oldPath, join(newDir, dbName))
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = oldPath + suffix
    if (existsSync(sidecar)) copyFileSync(sidecar, join(newDir, dbName + suffix))
  }
}
