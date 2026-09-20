/**
 * 品牌图标生成脚本（唯一源：scripts/todolist-icon.png）。
 *
 * 源图是 1261×1247 的 RGBA PNG（非正方形，四周有透明边）。本脚本做三件事：
 *   1. 按 alpha 通道裁出内容包围盒，再补成正方形画布（内容居中、铺满画布）——
 *      ICO 与各窗口图标的画布必须正方形，否则图标会被拉伸变形
 *   2. resources/icon.png —— 512×512，BrowserWindow 的 icon 用它
 *      （Windows 上窗口图标同时决定任务栏图标；打包后则由 exe 图标接管）
 *   3. build/icon.ico —— 多尺寸 ICO（16/24/32/48/64/128/256，256 用 PNG 压缩），
 *      这是 electron-builder 的约定位置：打包时自动作为 exe 图标，
 *      安装器创建的快捷方式也直接继承 exe 图标
 *
 * 源图变了就重跑：node scripts/gen-icons.mjs
 * （依赖 pngjs / png2icons，均为纯 JS，无原生二进制）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { PNG } from 'pngjs'
import png2icons from 'png2icons'

const SRC = new URL('./todolist-icon.png', import.meta.url)
const OUT_PNG = new URL('../resources/icon.png', import.meta.url)
const OUT_ICO = new URL('../build/icon.ico', import.meta.url)

/** 双三次重采样到 size×size（pngjs 像素缓冲 → 像素缓冲） */
function resize(src, size) {
  const dst = new PNG({ width: size, height: size })
  const sw = src.width
  const sh = src.height
  const xRatio = sw / size
  const yRatio = sh / size
  for (let y = 0; y < size; y++) {
    // 双线性已足够：源是平滑的矢量感插画，高分辨率源缩到 ≤512 无可感知差异
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * yRatio))
    for (let x = 0; x < size; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * xRatio))
      const si = (sy * sw + sx) << 2
      const di = (y * size + x) << 2
      dst.data[di] = src.data[si]
      dst.data[di + 1] = src.data[si + 1]
      dst.data[di + 2] = src.data[si + 2]
      dst.data[di + 3] = src.data[si + 3]
    }
  }
  return dst
}

// ── 1. 解码 + 裁剪透明边 + 补正方形 ──────────────────────────────────────────
const raw = PNG.sync.read(readFileSync(SRC))
console.log(`源图: ${raw.width}x${raw.height}`)

// alpha 包围盒
let minX = raw.width, minY = raw.height, maxX = -1, maxY = -1
for (let y = 0; y < raw.height; y++) {
  for (let x = 0; x < raw.width; x++) {
    if (raw.data[((y * raw.width + x) << 2) + 3] > 8) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
}
if (maxX < 0) throw new Error('源图完全透明，没有可见内容')
const cw = maxX - minX + 1
const ch = maxY - minY + 1
console.log(`内容包围盒: (${minX},${minY}) ${cw}x${ch}`)

// 居中放进正方形画布，短边方向补透明。长边已等于画布边长，无需缩放，直接平移放入
const side = Math.max(cw, ch)
const canvas = new PNG({ width: side, height: side })
for (let y = 0; y < ch; y++) {
  const ox = (side - cw) >> 1
  const oy = (side - ch) >> 1
  for (let x = 0; x < cw; x++) {
    const si = ((minY + y) * raw.width + (minX + x)) << 2
    const di = ((oy + y) * side + (ox + x)) << 2
    canvas.data[di] = raw.data[si]
    canvas.data[di + 1] = raw.data[si + 1]
    canvas.data[di + 2] = raw.data[si + 2]
    canvas.data[di + 3] = raw.data[si + 3]
  }
}
console.log(`正方形画布: ${side}x${side}`)

// ── 2. resources/icon.png（512×512，窗口/任务栏图标）────────────────────────
mkdirSync(new URL('../resources/', import.meta.url), { recursive: true })
const winPng = resize(canvas, 512)
writeFileSync(OUT_PNG, PNG.sync.write(winPng))
console.log(`已写 resources/icon.png (512x512)`)

// ── 3. build/icon.ico（多尺寸，electron-builder 约定位置）────────────────────
mkdirSync(new URL('../build/', import.meta.url), { recursive: true })
// 喂全分辨率方形图，png2icons 内部双三次缩出各尺寸；256 档用 PNG 压缩省体积
const ico = png2icons.createICO(
  PNG.sync.write(canvas),
  png2icons.BICUBIC2,
  0,
  true
)
if (!ico) throw new Error('png2icons 生成 ICO 失败')
writeFileSync(OUT_ICO, ico)
console.log(`已写 build/icon.ico (${ico.length} bytes)`)
