/**
 * 品牌图标装配脚本（唯一源：scripts/todolist-{16,32,48,64,128,256}x*.png）。
 *
 * ⚠ 源图是**手工逐档处理过的像素**（桌面 48 / 任务栏 32 / 小图标 16 各自对齐像素网格），
 * 本脚本只做「装配 + 拷贝」，**绝不缩放** —— 任何重采样都会把用户修好的锯齿带回来。
 * （历史版本曾从单张 1261×1247 源图重采样生成各档，因锯齿问题已被这批手工图替代。）
 *
 * 产出三处：
 *   1. resources/icon.png      ← todolist-256x256.png
 *      dev 模式 BrowserWindow 的 icon（Windows 上窗口图标决定 dev 任务栏图标；
 *      打包后由 exe 内嵌图标接管）
 *   2. resources/icon-16.png / icon-32.png ← 同名源图
 *      托盘专用：托盘在 100% DPI 要 16px、200% 要 32px，直接喂精确档位，
 *      不从大图缩放（见 src/main/system/tray.ts）
 *   3. build/icon.ico ← 六档 PNG 装配的多尺寸 ICO（PNG 压缩条目，32bpp）
 *      electron-builder 约定位置：打包时自动作为 exe 图标，
 *      安装器创建的快捷方式也继承它（见 dev-shortcut.ts 的补写逻辑）
 *
 * 源图变了就重跑：node scripts/gen-icons.mjs（纯 node:fs 实现，无第三方依赖）
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = join(ROOT, 'scripts')
const SIZES = [16, 32, 48, 64, 128, 256]

/** 读源 PNG，顺带校验尺寸头（IHDR：宽高各 4 字节，大端） */
function readSizePng(size) {
  const file = join(SRC_DIR, `todolist-${size}x${size}.png`)
  const buf = readFileSync(file)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  if (w !== size || h !== size) {
    throw new Error(`${file} 实际尺寸 ${w}x${h}，与文件名 ${size}x${size} 不符`)
  }
  return buf
}

// ── 1. resources/：窗口图标 + 托盘精确档位 ───────────────────────────────────
copyFileSync(join(SRC_DIR, 'todolist-256x256.png'), join(ROOT, 'resources', 'icon.png'))
copyFileSync(join(SRC_DIR, 'todolist-16x16.png'), join(ROOT, 'resources', 'icon-16.png'))
copyFileSync(join(SRC_DIR, 'todolist-32x32.png'), join(ROOT, 'resources', 'icon-32.png'))
console.log('已写 resources/icon.png (256) / icon-16.png / icon-32.png')

// ── 2. build/icon.ico：把六档 PNG 原样装进 ICO 容器 ──────────────────────────
// ICO 结构：6 字节头 + N 个 16 字节目录项 + 各图像数据。
// 目录项：宽(256 写 0) 高(同) 调色板数(0) 保留(0) 色面(1) 位深(32) 数据长 偏移
const pngs = SIZES.map(readSizePng)
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(pngs.length, 4)

const entries = []
let offset = 6 + 16 * pngs.length
for (let i = 0; i < pngs.length; i++) {
  const e = Buffer.alloc(16)
  const size = SIZES[i]
  e.writeUInt8(size % 256, 0) // 宽（256 → 0）
  e.writeUInt8(size % 256, 1) // 高
  e.writeUInt8(0, 2) // 调色板色数
  e.writeUInt8(0, 3) // 保留
  e.writeUInt16LE(1, 4) // 色面
  e.writeUInt16LE(32, 6) // 位深
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += pngs[i].length
}

const ico = Buffer.concat([header, ...entries, ...pngs])
writeFileSync(join(ROOT, 'build', 'icon.ico'), ico)
console.log(`已写 build/icon.ico (${ico.length} bytes，${SIZES.join('/')} 全 PNG 条目)`)
