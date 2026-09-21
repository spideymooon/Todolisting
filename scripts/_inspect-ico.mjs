/** 临时脚本：校验装配产物与手工 ICO 逐字节一致（用完即删） */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const a = readFileSync(join(dir, 'todolist-icon.ico'))
const b = readFileSync(join(dir, '..', 'build', 'icon.ico'))
console.log(a.equals(b) ? `IDENTICAL (${b.length} bytes)` : `DIFF a=${a.length} b=${b.length}`)
