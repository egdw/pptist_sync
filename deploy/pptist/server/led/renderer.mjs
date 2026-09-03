import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { drawDefaultTemplate } from './templates/default.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
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
  try { portrait = await loadImage(custom && fs.existsSync(custom) ? custom : fallback) }
  catch { /* 图片缺失时仍正常渲染文字 */ }
  drawDefaultTemplate(canvas.getContext('2d'), state, role, portrait, theme)
  return canvas.encode('jpeg', 90)
}
