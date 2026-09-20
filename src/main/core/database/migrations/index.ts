import type { Migration } from '../migrate'
import { migration001 } from './001_init'
import { migration002 } from './002_reminder'

/** 迁移按 version 升序执行，只追加、不修改已发布的迁移 */
export const migrations: Migration[] = [migration001, migration002]
