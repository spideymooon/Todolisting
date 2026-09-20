import type { Db } from '../../core/database/connection'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'

/**
 * settings 表的 KV 读写。值统一 JSON.stringify 存字符串，
 * 免得以后加布尔/数字类型时还要做迁移。
 */
export class SettingsService {
  constructor(private readonly db: Db) {}

  all(): AppSettings {
    const rows = this.db.all('SELECT key, value FROM settings') as unknown as Array<{
      key: string
      value: string
    }>
    const stored: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value)
      } catch {
        // 值损坏时忽略该键，回落到默认值，不让设置页整页报错
      }
    }
    return { ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString()
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue
      this.db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify(value), now]
      )
    }
    return this.all()
  }
}
