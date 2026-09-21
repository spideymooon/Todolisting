/**
 * 003_repeat —— 重复任务（《TodoList-重复任务功能》）
 *
 * 只做一件事：tasks 加一列 repeat_rule（TEXT，存 JSON 或 NULL）。
 *
 * 为什么复用既有列而不重建表：
 *  - 001 建表时就预留了 `is_template` 与 `series_id` 两个字段，且**所有业务查询
 *    都已经在过滤 `is_template = 0`**。首版采用「规则 + 当前实例」模式（§6：
 *    绝不预生成未来任务），is_template 保持恒 0 即可，既有查询一行不用改。
 *  - `series_id` 用于把同一条规则的多个实例串起来：首实例写入自身 id，
 *    后续实例继承。首版只需在生成时读写它 —— 但 001 已建列，同样无需迁移。
 *  - 因此本次迁移是纯 `ADD COLUMN`，与 002 的范式一致，零表重建、零数据搬迁。
 *
 * repeat_rule 存 JSON 而不是拆 6 列：规则是一个整体概念（改就整体改），
 * 拆列会让 COLUMN_SQL / update 白名单 / IPC 参数全面膨胀。校验放在应用层
 * （@shared/repeat 的 normalizeRule），非法值一律当 NULL —— 坏数据不该让列表炸掉。
 */

import type { Migration } from '../migrate'

export const migration003: Migration = {
  version: 3,
  name: 'repeat',
  up: (db) => {
    // NULL = 不重复。存量任务天然全是 NULL，正是期望值，不需要回填
    db.exec(`ALTER TABLE tasks ADD COLUMN repeat_rule TEXT;`)

    // 按 series 查「这条规则的其它实例」是生成下一实例时的幂等判断路径：
    // 生成前先查 series_id + due_date 是否已存在。给它建个索引。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_series
               ON tasks (series_id, due_date);`)
  }
}
