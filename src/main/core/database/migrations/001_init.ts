/**
 * 001_init —— 初始表结构
 *
 * 时间字段约定（《00-架构设计》§3.1）：
 *  - 时刻类：ISO UTC 字符串（created_at / updated_at / completed_at / due_at_utc）
 *  - 日历日类：本地 `YYYY-MM-DD`（due_date）—— 避免时区换算把日期错位一天
 */

import type { Migration } from '../migrate'

const STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id                     TEXT    PRIMARY KEY,
     title                  TEXT    NOT NULL,
     note                   TEXT,
     status                 TEXT    NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending','completed')),
     priority               INTEGER NOT NULL DEFAULT 3
                                    CHECK (priority IN (1,2,3)),
     due_date               TEXT,
     due_time               TEXT,
     due_at_utc             TEXT,
     remind_advance_minutes INTEGER,
     completed_at           TEXT,
     sort_order             INTEGER NOT NULL DEFAULT 0,
     is_template            INTEGER NOT NULL DEFAULT 0,
     series_id              TEXT,
     created_at             TEXT    NOT NULL,
     updated_at             TEXT    NOT NULL,
     deleted_at             TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS tags (
     id         TEXT PRIMARY KEY,
     name       TEXT NOT NULL UNIQUE,
     color      TEXT NOT NULL DEFAULT 'gray',
     created_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS task_tags (
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     tag_id  TEXT NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
     PRIMARY KEY (task_id, tag_id)
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS widgets (
     id            TEXT    PRIMARY KEY,
     type          TEXT    NOT NULL
                           CHECK (type IN ('today','upcoming','progress','quick_add')),
     x             INTEGER,
     y             INTEGER,
     width         INTEGER,
     height        INTEGER,
     opacity       REAL    NOT NULL DEFAULT 1,
     always_on_top INTEGER NOT NULL DEFAULT 1,
     display_id    INTEGER,
     visible       INTEGER NOT NULL DEFAULT 1,
     config        TEXT,
     created_at    TEXT    NOT NULL,
     updated_at    TEXT    NOT NULL
   )`,

  // 防重复通知的物理防线：plan_key = `${taskId}|${type}|${scheduledAt}` UNIQUE
  // 配合 INSERT OR IGNORE 做「幂等占位」（《00-架构设计》§4.2）
  `CREATE TABLE IF NOT EXISTS notification_logs (
     id           TEXT PRIMARY KEY,
     task_id      TEXT NOT NULL,
     type         TEXT NOT NULL,
     scheduled_at TEXT NOT NULL,
     plan_key     TEXT NOT NULL UNIQUE,
     channel      TEXT,
     status       TEXT NOT NULL DEFAULT 'planned'
                       CHECK (status IN ('planned','sent','failed','skipped')),
     error        TEXT,
     sent_at      TEXT,
     created_at   TEXT NOT NULL
   )`,

  // 三列的查询索引 —— 看板每次切换都会打这三个条件
  `CREATE INDEX IF NOT EXISTS idx_tasks_board
     ON tasks (status, due_date, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_due
     ON tasks (due_date, due_at_utc)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_updated
     ON tasks (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_task
     ON notification_logs (task_id, status)`
]

export const migration001: Migration = {
  version: 1,
  name: 'init',
  up: (db) => {
    for (const sql of STATEMENTS) db.exec(`${sql};`)
  }
}
