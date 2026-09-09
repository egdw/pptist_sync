// 用合成的证件照式半身像复现「人头太大」，并验证修复后的尺寸
import path from 'node:path'
import fs from 'node:fs'
import { createCanvas } from '@napi-rs/canvas'
import { renderLedJpeg } from '../../server/led/renderer.mjs'

const outDir = path.resolve('tests/lcd/out')
fs.mkdirSync(outDir, { recursive: true })

// 画一张典型证件照：白底、头占照片高约 55%、肩部在底部
async function makeIdPhoto(file) {
  const W = 450, H = 600
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)
  // 肩膀
  ctx.fillStyle = '#3a5a8c'
  ctx.beginPath()
  ctx.ellipse(W / 2, H * 1.02, W * 0.42, H * 0.30, 0, 0, Math.PI * 2)
  ctx.fill()
  // 头
  ctx.fillStyle = '#d9a066'
  ctx.beginPath()
  ctx.ellipse(W / 2, H * 0.40, W * 0.19, H * 0.155, 0, 0, Math.PI * 2)
  ctx.fill()
  // 头发
  ctx.fillStyle = '#222'
  ctx.beginPath()
  ctx.ellipse(W / 2, H * 0.335, W * 0.195, H * 0.09, 0, Math.PI, Math.PI * 2)
  ctx.fill()
  fs.writeFileSync(file, canvas.toBuffer('image/jpeg'))
}

const state = {
  stage: '软硬件讲解调试',
  active: ['manager'],
  lead: 'manager',
  roles: { manager: { task: '行车数据可信治理与事故判责平台讲解' } },
}

await makeIdPhoto(path.join(outDir, 'id-photo.jpg'))
const jpeg = await renderLedJpeg(state, 'manager', outDir, {})
// renderLedJpeg 只找 {role}.image，改名
fs.renameSync(path.join(outDir, 'id-photo.jpg'), path.join(outDir, 'manager.image'))
const jpeg2 = await renderLedJpeg(state, 'manager', outDir, {})
fs.writeFileSync(path.join(outDir, 'lcd-before.png'), jpeg2)
console.log('rendered ->', path.join(outDir, 'lcd-before.png'), jpeg2.length, 'bytes')
