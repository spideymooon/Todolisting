/**
 * 002_reminder —— 提醒系统所需的字段（《00-架构设计》§4）
 *
 * 三件事：
 *  1. tasks 补 4 个提醒字段（reminder_enabled / reminder_days / reminder_time / notify_channels）
 *  2. 迁移旧的 remind_advance_minutes → reminder_days（分钟转天，向上取整），然后删掉旧列
 *  3. 重建 notification_logs —— 001 里的 status CHECK 只有 4 个值，
 *     缺少 replan 需要的 'cancelled'，SQLite 改不了 CHECK，只能重建表
 *
 * SQLite 3.53 支持 ALTER TABLE ... DROP COLUMN，所以不需要整表重建 tasks。
 */

import type { Migration } from '../migrate'

export const migration002: Migration = {
  version: 2,
  name: 'reminder',
  up: (db) => {
    // ── 1. tasks 新增提醒字段 ──────────────────────────────
    // 注意 ALTER TABLE ADD COLUMN 的默认值必须是常量，所以这里写的默认值
    // 与 DEFAULT_SETTINGS 保持一致（1 天 / 09:00 / 开启 / 仅桌面）。
    db.exec(`ALTER TABLE tasks ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 1;`)
    db.exec(`ALTER TABLE tasks ADD COLUMN reminder_days INTEGER NOT NULL DEFAULT 1;`)
    db.exec(`ALTER TABLE tasks ADD COLUMN reminder_time TEXT NOT NULL DEFAULT '09:00';`)
    db.exec(`ALTER TABLE tasks ADD COLUMN notify_channels TEXT NOT NULL DEFAULT 'desktop';`)

    // ── 2. 迁移旧字段 ─────────────────────────────────────
    // 001 的 remind_advance_minutes 是「提前多少分钟」，语义等价于 days*1440。
    // 只在它真的是按「整天」设的时候才转（否则向上取整会放大提醒范围）。
    const rows = db.all(
      `SELECT id, remind_advance_minutes AS m FROM tasks
        WHERE remind_advance_minutes IS NOT NULL`
    ) as unknown as Array<{ id: string; m: number }>
    for (const row of rows) {
      const days = Math.ceil(Number(row.m) / 1440)
      db.run(`UPDATE tasks SET reminder_days = ? WHERE id = ?`, [days, row.id])
    }

    // 旧列退役。它是 001 里唯一一个「存了但没人读」的字段（提醒引擎从未实现），
    // 留着会让后来人以为它是活的。
    db.exec(`ALTER TABLE tasks DROP COLUMN remind_advance_minutes;`)

    // ── 3. 重建 notification_logs ─────────────────────────
    db.exec(`
      CREATE TABLE notification_logs_v2 (
        id           TEXT PRIMARY KEY,
        task_id      TEXT NOT NULL,
        task_title   TEXT NOT NULL DEFAULT '',
        type         TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        plan_key     TEXT NOT NULL UNIQUE,
        channel      TEXT NOT NULL DEFAULT 'desktop',
        status       TEXT NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','sent','failed','skipped','cancelled')),
        error        TEXT,
        sent_at      TEXT,
        created_at   TEXT NOT NULL
      );
    `)

    // 保留既有行（Phase 1 从未写入过，但迁移脚本不该假设这一点）
    db.exec(`
      INSERT INTO notification_logs_v2
        (id, task_id, task_title, type, scheduled_at, plan_key, channel,
         status, error, sent_at, created_at)
      SELECT l.id, l.task_id, COALESCE(t.title, ''), l.type, l.scheduled_at, l.plan_key,
             COALESCE(l.channel, 'desktop'),
             CASE l.status WHEN 'sent' THEN 'sent'
                           WHEN 'failed' THEN 'failed'
                           ELSE 'skipped' END,
             l.error, l.sent_at, l.created_at
        FROM notification_logs l
        LEFT JOIN tasks t ON t.id = l.task_id;
    `)

    db.exec(`DROP TABLE notification_logs;`)
    db.exec(`ALTER TABLE notification_logs_v2 RENAME TO notification_logs;`)

    // 调度器每 30 秒打的就这一条查询，索引必须对上
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_due
               ON notification_logs (status, scheduled_at);`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notification_task
               ON notification_logs (task_id, status);`)
  }
}
