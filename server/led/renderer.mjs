import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { drawDefaultTemplate } from './templates/default.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const portraitCache = new Map()

// 字体文件随部署包携带（server/assets/fonts/），源码仓库回退到 src/assets/fonts/；
// 都找不到时跳过注册（降级系统字体），不让 LED 渲染问题拖垮整个服务端
for (const fontPath of [
  path.resolve(moduleDir, '../assets/fonts/MiSans.woff2'),
  path.resolve(moduleDir, '../../src/assets/fonts/MiSans.woff2'),
]) {
  try {
    if (fs.existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, 'LedDisplay')
      break
    }
  }
  catch { /* 尝试下一个候选路径 */ }
}

export async function renderLedJpeg(state, role, portraitDir, theme = {}) {
  const canvas = createCanvas(1280, 800)
  const custom = portraitDir && path.join(portraitDir, `${role}.image`)
  const fallback = path.resolve(moduleDir, `../../reveal-example/reveal-markdown-evidence-screen-v4.2/portraits/${role}.png`)
  let portrait = null
  try {
    const source = custom && fs.existsSync(custom) ? custom : fallback
    portrait = await loadPreparedPortrait(source)
  }
  catch { /* 图片缺失时仍正常渲染文字 */ }
  drawDefaultTemplate(canvas.getContext('2d'), state, role, portrait, theme)
  return canvas.encode('jpeg', 92)
}

async function loadPreparedPortrait(source) {
  const stat = fs.statSync(source)
  const cacheKey = `${source}:${stat.size}:${Math.round(stat.mtimeMs)}`
  const cached = portraitCache.get(cacheKey)
  if (cached) return cached

  // 同一路径有新上传文件时清掉旧缓存。
  for (const key of portraitCache.keys()) if (key.startsWith(`${source}:`)) portraitCache.delete(key)

  const image = await loadImage(source)
  const prepared = preparePortrait(image)
  portraitCache.set(cacheKey, prepared)
  if (portraitCache.size > 12) portraitCache.delete(portraitCache.keys().next().value)
  return prepared
}

function preparePortrait(image) {
  const width = Math.max(1, image.width | 0)
  const height = Math.max(1, image.height | 0)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image, 0, 0, width, height)

  const frame = ctx.getImageData(0, 0, width, height)
  const data = frame.data

  // 只有检测到“白色背景与边缘连通”时才去白底。
  // 这样不会把眼白、衣服反光条等人物内部的亮色区域误删。
  if (edgeLooksWhite(data, width, height)) {
    removeConnectedWhiteBackground(data, width, height)
    ctx.putImageData(frame, 0, 0)
  }

  const bounds = alphaBounds(data, width, height)
  // 裁剪只用于去白底/去透明边，不用于放大：模板按 sourceWidth/Height（原图尺寸）
  // 计算 contain 缩放，再乘主题 portraitScale，避免半身照人脸撑满整块屏幕。
  if (!bounds) return { canvas, sourceWidth: width, sourceHeight: height }

  // 自动裁掉透明/空白边缘（仅去边，不放大人物；缩放由模板按原图尺寸决定）
  const padX = Math.max(8, Math.round((bounds.right - bounds.left + 1) * .035))
  const padTop = Math.max(8, Math.round((bounds.bottom - bounds.top + 1) * .025))
  const padBottom = Math.max(4, Math.round((bounds.bottom - bounds.top + 1) * .012))
  const left = Math.max(0, bounds.left - padX)
  const top = Math.max(0, bounds.top - padTop)
  const right = Math.min(width - 1, bounds.right + padX)
  const bottom = Math.min(height - 1, bounds.bottom + padBottom)
  const cropW = right - left + 1
  const cropH = bottom - top + 1

  if (cropW >= width * .96 && cropH >= height * .96) return { canvas, sourceWidth: width, sourceHeight: height }
  const cropped = createCanvas(cropW, cropH)
  cropped.getContext('2d').drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH)
  return { canvas: cropped, sourceWidth: width, sourceHeight: height }
}

function edgeLooksWhite(data, width, height) {
  const step = Math.max(1, Math.floor(Math.min(width, height) / 120))
  let count = 0, white = 0, transparent = 0
  const sample = (x, y) => {
    const i = (y * width + x) * 4
    const a = data[i + 3]
    count++
    if (a < 20) { transparent++; return }
    if (isBackgroundWhite(data[i], data[i + 1], data[i + 2], true)) white++
  }
  for (let x = 0; x < width; x += step) { sample(x, 0); sample(x, height - 1) }
  for (let y = step; y < height - step; y += step) { sample(0, y); sample(width - 1, y) }
  // 已经透明的 PNG 不需要再次抠图；白底 JPG/PNG 才启用。
  return count > 0 && transparent / count < .35 && white / Math.max(1, count - transparent) > .52
}

function removeConnectedWhiteBackground(data, width, height) {
  const total = width * height
  const seen = new Uint8Array(total)
  const queue = new Int32Array(total)
  let head = 0, tail = 0

  const push = index => {
    if (index < 0 || index >= total || seen[index]) return
    const i = index * 4
    if (data[i + 3] < 8 || isBackgroundWhite(data[i], data[i + 1], data[i + 2], false)) {
      seen[index] = 1
      queue[tail++] = index
    }
  }

  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x) }
  for (let y = 1; y < height - 1; y++) { push(y * width); push(y * width + width - 1) }

  while (head < tail) {
    const index = queue[head++]
    const x = index % width
    const y = (index / width) | 0
    if (x > 0) push(index - 1)
    if (x + 1 < width) push(index + 1)
    if (y > 0) push(index - width)
    if (y + 1 < height) push(index + width)
  }

  for (let index = 0; index < total; index++) {
    if (!seen[index]) continue
    const i = index * 4
    data[i + 3] = 0
  }
}

function isBackgroundWhite(r, g, b, strict) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const mean = (r + g + b) / 3
  const chroma = max - min
  return strict ? mean >= 225 && chroma <= 38 : mean >= 205 && chroma <= 52
}

function alphaBounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 18) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  return right < left || bottom < top ? null : { left, top, right, bottom }
}
