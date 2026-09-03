import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { drawDefaultTemplate } from './templates/default.mjs'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
GlobalFonts.registerFromPath(path.resolve(moduleDir, '../../src/assets/fonts/MiSans.woff2'), 'LedDisplay')

export async function renderLedJpeg(state, role, portraitDir) {
  const canvas = createCanvas(1280, 800)
  const custom = portraitDir && path.join(portraitDir, `${role}.image`)
  const fallback = path.resolve(moduleDir, `../../reveal-example/reveal-markdown-evidence-screen-v4.2/portraits/${role}.png`)
  let portrait = null
  try { portrait = await loadImage(custom && fs.existsSync(custom) ? custom : fallback) }
  catch { /* 图片缺失时仍正常渲染文字 */ }
  drawDefaultTemplate(canvas.getContext('2d'), state, role, portrait)
  return canvas.encode('jpeg', 90)
}
