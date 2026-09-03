import { ROLE_CONFIG } from '../role-config.mjs'

export function drawDefaultTemplate(ctx, state, role, portrait, rawTheme = {}) {
  const cfg = ROLE_CONFIG[role]
  const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback))
  const theme = {
    background: /^#[0-9a-f]{6}$/i.test(rawTheme.background) ? rawTheme.background : '#101b31',
    taskFontSize: bounded(rawTheme.taskFontSize, 46, 24, 86),
    roleFontSize: bounded(rawTheme.roleFontSize, 60, 28, 82),
    stageFontSize: bounded(rawTheme.stageFontSize, 56, 28, 82),
    maxTaskLines: Math.round(bounded(rawTheme.maxTaskLines, 3, 1, 4)),
  }
  const active = state.active.includes(role)
  const lead = state.lead === role
  const gradient = ctx.createLinearGradient(0, 0, 1280, 800)
  gradient.addColorStop(0, theme.background); gradient.addColorStop(1, '#07101f')
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 800)
  if (active) {
    const glow = ctx.createRadialGradient(1040, 220, 20, 1040, 220, 520)
    glow.addColorStop(0, `${cfg.accent}66`); glow.addColorStop(1, `${cfg.accent}00`)
    ctx.fillStyle = glow; ctx.fillRect(540, 0, 740, 700)
    ctx.strokeStyle = cfg.accent; ctx.lineWidth = 8; ctx.roundRect(42, 38, 1196, 724, 28); ctx.stroke()
  }
  ctx.fillStyle = cfg.accent; ctx.fillRect(0, 0, 18, 800)
  ctx.fillStyle = '#8090aa'; ctx.font = '32px LedDisplay, sans-serif'; ctx.fillText('当前环节', 76, 90)
  ctx.fillStyle = active ? '#fff' : '#aab3c4'; drawWrapped(ctx, state.stage || '—', 76, 150, 700, 2, theme.stageFontSize, theme.stageFontSize + 8)
  ctx.fillStyle = active ? cfg.accent : '#718098'; ctx.beginPath(); ctx.arc(1005, 102, 18, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = active ? '#fff' : '#aab3c4'; ctx.font = 'bold 40px LedDisplay, sans-serif'; ctx.fillText(active ? '进行中' : '准备中', 1040, 118)
  ctx.fillStyle = active ? '#fff' : '#9ba6b9'; drawWrapped(ctx, cfg.name, 76, 292, 700, 2, theme.roleFontSize, theme.roleFontSize + 8)
  if (lead) {
    ctx.fillStyle = cfg.accent; ctx.roundRect(76, 380, 180, 54, 27); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.font = 'bold 28px LedDisplay, sans-serif'; ctx.fillText('主导岗位', 108, 417)
  }
  ctx.fillStyle = active ? cfg.accent : '#657087'; ctx.font = '30px LedDisplay, sans-serif'; ctx.fillText('当前任务', 76, 505)
  ctx.fillStyle = active ? '#fff' : '#9ba6b9'; drawWrapped(ctx, state.roles?.[role]?.task || '—', 76, 570, 700, theme.maxTaskLines, theme.taskFontSize, theme.taskFontSize + 12)
  ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.roundRect(825, 170, 370, 520, 24); ctx.fill()
  ctx.strokeStyle = active ? cfg.accent : '#3b4960'; ctx.lineWidth = 5; ctx.roundRect(845, 190, 330, 400, 18); ctx.stroke()
  if (portrait) {
    ctx.save(); ctx.beginPath(); ctx.roundRect(850, 195, 320, 390, 14); ctx.clip()
    const scale = Math.max(320 / portrait.width, 390 / portrait.height)
    const w = portrait.width * scale; const h = portrait.height * scale
    ctx.drawImage(portrait, 850 + (320 - w) / 2, 195 + (390 - h) / 2, w, h); ctx.restore()
  }
  ctx.fillStyle = active ? '#fff' : '#aab3c4'; ctx.font = 'bold 29px LedDisplay, sans-serif'; ctx.textAlign = 'center'
  ctx.fillText(cfg.name, 1010, 644); ctx.textAlign = 'left'
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
  wrapText(ctx, text, maxWidth).slice(0, maxLines).forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight))
}
