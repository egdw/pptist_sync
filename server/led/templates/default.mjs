import { ROLE_CONFIG } from '../role-config.mjs'

const ROLE_INDEX = { manager: '01', platform: '02', twin: '03', hardware: '04' }

export function drawDefaultTemplate(ctx, state, role, portrait, rawTheme = {}) {
  const cfg = ROLE_CONFIG[role]
  const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback))
  const colorHex = value => (/^#[0-9a-f]{6}$/i.test(value) ? value : '')
  const css = String(rawTheme.customCss || '')
  const cssSize = (name, fallback, min, max) => bounded(readCssPixels(css, name), fallback, min, max)
  const theme = {
    background: colorHex(rawTheme.background) || '#101b31',
    taskFontSize: bounded(rawTheme.taskFontSize, 54, 24, 86),
    roleFontSize: bounded(rawTheme.roleFontSize, 68, 28, 82),
    stageFontSize: bounded(rawTheme.stageFontSize, 50, 28, 82),
    maxTaskLines: Math.round(bounded(rawTheme.maxTaskLines, 2, 1, 4)),
    stageLabelFontSize: cssSize('--lcd-stage-label-font-size', rawTheme.stageLabelFontSize || 28, 18, 40),
    roleIndexFontSize: cssSize('--lcd-role-index-font-size', rawTheme.roleIndexFontSize || 32, 20, 48),
    taskLabelFontSize: cssSize('--lcd-task-label-font-size', rawTheme.taskLabelFontSize || 27, 18, 40),
    badgeFontSize: cssSize('--lcd-badge-font-size', rawTheme.badgeFontSize || 29, 18, 36),
    footerFontSize: cssSize('--lcd-footer-font-size', rawTheme.footerFontSize || 25, 18, 34),
    // 头像缩放系数：1 = 原图 contain 恰好填满舞台内区，默认 0.8 留出呼吸空间
    portraitScale: bounded(rawTheme.portraitScale, 0.8, 0.35, 1),
    // 可选主题字段：非活跃文字色与岗位主色覆盖（lcd-theme.json 高级编辑）
    inactiveColor: colorHex(rawTheme.inactiveColor) || '#65748d',
  }
  const active = state.active.includes(role)
  const lead = state.lead === role
  const accent = colorHex(rawTheme.roleAccents?.[role]) || cfg.accent
  const muted = theme.inactiveColor

  drawBackground(ctx, theme.background, accent, active)

  // 左栏使用明确的纵向区域。字号变大时文字在自己的区域内自适应，
  // 不再因为固定基线向上侵入标签或向下压住下一组标题。
  ctx.fillStyle = active ? accent : muted
  ctx.roundRect(50, 42, 9, 95, 5); ctx.fill()
  ctx.font = `${theme.stageLabelFontSize}px LedDisplay, sans-serif`
  ctx.fillStyle = active ? '#9fdcff' : '#8290a5'
  ctx.fillText('当前环节', 82, 76)
  ctx.fillStyle = active ? '#ffffff' : '#aab3c4'
  drawTextInBox(ctx, state.stage || '—', {
    x: 82, top: 84, width: 470, height: 82,
    maxLines: 1, preferredSize: theme.stageFontSize, minSize: 28,
  })

  drawStatus(ctx, active, lead, accent, theme.badgeFontSize)

  // 岗位作为第一视觉层级，不在人物下方重复岗位名称。
  ctx.fillStyle = active ? accent : muted
  ctx.font = `bold ${theme.roleIndexFontSize}px LedDisplay, sans-serif`
  ctx.fillText(ROLE_INDEX[role] || '—', 82, 236)
  ctx.fillStyle = active ? '#ffffff' : '#a8b2c2'
  drawTextInBox(ctx, cfg.name, {
    x: 82, top: 250, width: 650, height: 180,
    maxLines: 2, preferredSize: theme.roleFontSize, minSize: 28,
  })

  // 当前任务支持主题设置的行数；超出安全区域时自动缩小或省略。
  ctx.fillStyle = active ? accent : muted
  ctx.font = `${theme.taskLabelFontSize}px LedDisplay, sans-serif`
  ctx.fillText('当前任务', 82, 478)
  ctx.fillStyle = active ? '#f6fbff' : '#9aa6b7'
  drawTextInBox(ctx, state.roles?.[role]?.task || '—', {
    x: 82, top: 500, width: 650, height: 196,
    maxLines: theme.maxTaskLines, preferredSize: theme.taskFontSize, minSize: 24,
  })

  drawPortraitStage(ctx, portrait, accent, active, theme.portraitScale)

  // 底部只给出轻量状态条，远距离也容易辨认。
  ctx.fillStyle = active ? `${accent}28` : 'rgba(255,255,255,.035)'
  ctx.roundRect(78, 718, 646, 46, 23); ctx.fill()
  ctx.fillStyle = active ? accent : muted
  ctx.beginPath(); ctx.arc(106, 741, 7, 0, Math.PI * 2); ctx.fill()
  ctx.font = `${theme.footerFontSize}px LedDisplay, sans-serif`
  ctx.fillText(active ? (lead ? '当前任务主要负责人 · 工作进行中' : '协同岗位 · 工作进行中') : '等待当前环节', 128, 750)
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

function drawStatus(ctx, active, lead, accent, fontSize) {
  const label = active ? (lead ? '当前任务主要负责人' : '协助任务人员') : '准备中'
  ctx.font = `bold ${fontSize}px LedDisplay, sans-serif`
  const width = Math.ceil(ctx.measureText(label).width) + 70
  // 长标签放在人物区上方居中，与左侧“当前环节”彻底分栏。
  const x = 775 + (475 - width) / 2
  ctx.fillStyle = active ? `${accent}25` : 'rgba(255,255,255,.055)'
  ctx.strokeStyle = active ? `${accent}aa` : '#39465a'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.roundRect(x, 48, width, 52, 26); ctx.fill(); ctx.stroke()
  ctx.fillStyle = active ? accent : '#79879b'
  ctx.beginPath(); ctx.arc(x + 24, 74, 7, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = active ? '#ffffff' : '#9da8b8'
  ctx.save(); ctx.textBaseline = 'middle'; ctx.fillText(label, x + 43, 74); ctx.restore()
}

function drawPortraitStage(ctx, portrait, accent, active, portraitScale) {
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

  // renderer 已去白底并裁边；缩放按「原图 contain × portraitScale」计算，
  // 裁剪不改变人物在屏上的视觉大小，只去掉白底与空白边缘。
  const innerX = x + 10, innerY = y + 18, innerW = w - 20, innerH = h - 16
  const scale = Math.min(innerW / portrait.sourceWidth, innerH / portrait.sourceHeight) * portraitScale
  const pw = portrait.canvas.width * scale
  const ph = portrait.canvas.height * scale
  const px = innerX + (innerW - pw) / 2
  const py = innerY + innerH - ph

  ctx.save()
  ctx.shadowColor = active ? `${accent}88` : 'rgba(0,0,0,.42)'
  ctx.shadowBlur = active ? 32 : 18
  ctx.shadowOffsetY = 10
  ctx.globalAlpha = active ? 1 : .78
  ctx.drawImage(portrait.canvas, px, py, pw, ph)
  ctx.restore()
}

function wrapText(ctx, text, maxWidth) {
  const lines = []; let line = ''
  for (const char of String(text)) {
    if (ctx.measureText(line + char).width > maxWidth && line) { lines.push(line); line = char }
    else line += char
  }
  if (line) lines.push(line)
  // 避免中文岗位名出现“上一行很长、末行只剩一个字”的孤字排版。
  if (lines.length > 1) {
    const last = lines.length - 1
    while (lines[last - 1].length > 1 && ctx.measureText(lines[last]).width < ctx.measureText(lines[last - 1]).width * .55) {
      const moved = lines[last - 1].slice(-1)
      if (ctx.measureText(moved + lines[last]).width > maxWidth) break
      lines[last - 1] = lines[last - 1].slice(0, -1)
      lines[last] = moved + lines[last]
    }
  }
  return lines
}

function readCssPixels(css, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`, 'i'))
  return match ? Number(match[1]) : 0
}

function drawTextInBox(ctx, text, options) {
  const { x, top, width, height, maxLines, preferredSize, minSize } = options
  let fontSize = preferredSize
  let lines = []
  let lineHeight = 0

  // 同时满足宽度、最大行数和区域高度；优先保留用户选择的大字号。
  for (; fontSize >= minSize; fontSize--) {
    ctx.font = `bold ${fontSize}px LedDisplay, sans-serif`
    lines = wrapText(ctx, text, width)
    lineHeight = Math.ceil(fontSize * 1.18)
    if (lines.length <= maxLines && lines.length * lineHeight <= height) break
  }
  fontSize = Math.max(minSize, fontSize)
  lineHeight = Math.ceil(fontSize * 1.18)

  ctx.font = `bold ${fontSize}px LedDisplay, sans-serif`
  lines = wrapText(ctx, text, width)
  const clipped = lines.length > maxLines
  lines = lines.slice(0, maxLines)
  if (clipped && lines.length) lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], width)

  ctx.save()
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => ctx.fillText(line, x, top + i * lineHeight))
  ctx.restore()
}

function ellipsize(ctx, text, maxWidth) {
  let value = String(text)
  while (value && ctx.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1)
  return `${value}…`
}
