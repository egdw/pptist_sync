import { ROLE_CONFIG } from '../role-config.mjs'

const ROLE_INDEX = { manager: '01', platform: '02', twin: '03', hardware: '04' }

export function drawDefaultTemplate(ctx, state, role, portrait, rawTheme = {}) {
  const cfg = ROLE_CONFIG[role]
  const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback))
  const theme = {
    background: /^#[0-9a-f]{6}$/i.test(rawTheme.background) ? rawTheme.background : '#101b31',
    taskFontSize: bounded(rawTheme.taskFontSize, 54, 36, 72),
    roleFontSize: bounded(rawTheme.roleFontSize, 68, 44, 82),
    stageFontSize: bounded(rawTheme.stageFontSize, 50, 34, 72),
    maxTaskLines: Math.round(bounded(rawTheme.maxTaskLines, 2, 1, 2)),
  }
  const active = state.active.includes(role)
  const lead = state.lead === role
  const accent = cfg.accent

  drawBackground(ctx, theme.background, accent, active)

  // 顶部：只保留环节和状态，减少重复信息。
  ctx.fillStyle = active ? accent : '#65748d'
  ctx.roundRect(50, 42, 9, 95, 5); ctx.fill()
  ctx.font = '28px LedDisplay, sans-serif'
  ctx.fillStyle = active ? '#9fdcff' : '#8290a5'
  ctx.fillText('当前环节', 82, 76)
  ctx.fillStyle = active ? '#ffffff' : '#aab3c4'
  drawWrapped(ctx, state.stage || '—', 82, 130, 670, 1, theme.stageFontSize, theme.stageFontSize + 6)

  drawStatus(ctx, active, lead, accent)

  // 岗位作为第一视觉层级，不在人物下方重复岗位名称。
  ctx.fillStyle = active ? accent : '#607188'
  ctx.font = 'bold 32px LedDisplay, sans-serif'
  ctx.fillText(ROLE_INDEX[role] || '—', 82, 236)
  ctx.fillStyle = active ? '#ffffff' : '#a8b2c2'
  drawWrapped(ctx, cfg.name, 82, 310, 690, 2, theme.roleFontSize, theme.roleFontSize + 10)

  // 当前任务只保留两行，并明显放大。
  ctx.fillStyle = active ? accent : '#6f7e92'
  ctx.font = '27px LedDisplay, sans-serif'
  ctx.fillText('当前任务', 82, 492)
  ctx.fillStyle = active ? '#f6fbff' : '#9aa6b7'
  drawWrapped(ctx, state.roles?.[role]?.task || '—', 82, 558, 650, theme.maxTaskLines, theme.taskFontSize, theme.taskFontSize + 15)

  drawPortraitStage(ctx, portrait, accent, active)

  // 底部只给出轻量状态条，远距离也容易辨认。
  ctx.fillStyle = active ? `${accent}28` : 'rgba(255,255,255,.035)'
  ctx.roundRect(78, 718, 646, 46, 23); ctx.fill()
  ctx.fillStyle = active ? accent : '#718096'
  ctx.beginPath(); ctx.arc(106, 741, 7, 0, Math.PI * 2); ctx.fill()
  ctx.font = '25px LedDisplay, sans-serif'
  ctx.fillText(active ? (lead ? '当前主责 · 工作进行中' : '协同岗位 · 工作进行中') : '等待当前环节', 128, 750)
}

function drawBackground(ctx, base, accent, active) {
  const gradient = ctx.createLinearGradient(0, 0, 1280, 800)
  gradient.addColorStop(0, base)
  gradient.addColorStop(.58, '#0a1a31')
  gradient.addColorStop(1, '#050c18')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 1280, 800)

  // 右侧人物区用柔和光晕，不再使用白色照片卡片。
  const glow = ctx.createRadialGradient(1040, 360, 35, 1040, 360, 470)
  glow.addColorStop(0, active ? `${accent}38` : 'rgba(95,122,158,.13)')
  glow.addColorStop(.55, active ? `${accent}14` : 'rgba(58,76,103,.08)')
  glow.addColorStop(1, `${accent}00`)
  ctx.fillStyle = glow
  ctx.fillRect(720, 0, 560, 800)

  // 很淡的科技线条，只做层次，不抢文字。
  ctx.save()
  ctx.globalAlpha = active ? .18 : .09
  ctx.strokeStyle = accent
  ctx.lineWidth = 1
  for (let x = 38; x < 1280; x += 92) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 300, 800); ctx.stroke()
  }
  ctx.restore()

  ctx.fillStyle = active ? accent : '#53637b'
  ctx.fillRect(0, 0, 14, 800)
  ctx.fillStyle = active ? `${accent}80` : 'rgba(120,140,164,.18)'
  ctx.fillRect(49, 174, 686, 2)
}

function drawStatus(ctx, active, lead, accent) {
  const label = active ? (lead ? '当前主责' : '协同进行') : '准备中'
  ctx.font = 'bold 29px LedDisplay, sans-serif'
  const width = Math.ceil(ctx.measureText(label).width) + 70
  const x = 760 - width
  ctx.fillStyle = active ? `${accent}25` : 'rgba(255,255,255,.055)'
  ctx.strokeStyle = active ? `${accent}aa` : '#39465a'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.roundRect(x, 48, width, 52, 26); ctx.fill(); ctx.stroke()
  ctx.fillStyle = active ? accent : '#79879b'
  ctx.beginPath(); ctx.arc(x + 24, 74, 7, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = active ? '#ffffff' : '#9da8b8'
  ctx.fillText(label, x + 43, 84)
}

function drawPortraitStage(ctx, portrait, accent, active) {
  const x = 775, y = 122, w = 475, h = 652

  // 人物后面只有深色透明舞台，无白底、无厚相框。
  const panel = ctx.createLinearGradient(x, y, x, y + h)
  panel.addColorStop(0, active ? `${accent}12` : 'rgba(255,255,255,.018)')
  panel.addColorStop(1, 'rgba(0,0,0,.08)')
  ctx.fillStyle = panel
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 34); ctx.fill()

  ctx.save()
  ctx.globalAlpha = active ? .9 : .38
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(x + 34, y + 2); ctx.lineTo(x + 178, y + 2); ctx.stroke()
  ctx.beginPath(); ctx.moveTo(x + w - 108, y + h - 2); ctx.lineTo(x + w - 34, y + h - 2); ctx.stroke()
  ctx.restore()

  if (!portrait) return

  // renderer 已经裁掉透明/白色背景；这里采用 contain + 下对齐，保证头、肩、手臂不被裁断。
  const innerX = x + 10, innerY = y + 18, innerW = w - 20, innerH = h - 16
  const scale = Math.min(innerW / portrait.width, innerH / portrait.height)
  const pw = portrait.width * scale
  const ph = portrait.height * scale
  const px = innerX + (innerW - pw) / 2
  const py = innerY + innerH - ph

  ctx.save()
  ctx.shadowColor = active ? `${accent}88` : 'rgba(0,0,0,.42)'
  ctx.shadowBlur = active ? 32 : 18
  ctx.shadowOffsetY = 10
  ctx.globalAlpha = active ? 1 : .78
  ctx.drawImage(portrait, px, py, pw, ph)
  ctx.restore()
}

function wrapText(ctx, text, maxWidth) {
  const lines = []; let line = ''
  for (const char of String(text)) {
    if (ctx.measureText(line + char).width > maxWidth && line) { lines.push(line); line = char }
    else line += char
  }
  if (line) lines.push(line)
  return lines
}

function drawWrapped(ctx, text, x, y, maxWidth, maxLines, fontSize, lineHeight) {
  ctx.font = `bold ${fontSize}px LedDisplay, sans-serif`
  const lines = wrapText(ctx, text, maxWidth).slice(0, maxLines)
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight))
}
