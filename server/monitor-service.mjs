/**
 * 双 PPT 合成监控服务：主屏(左 640×800) + 副屏(右 640×800) → 1280×800 JPEG。
 *
 * 数据流：联动放映时，主屏/副屏播放窗口各自将当前页截图(dataURL)上传，
 * 每次任一半区更新都会重新合成（另一侧沿用最近一次画面），并叠加
 * 「当前页/总页」角标（主屏左上、副屏右上）。
 * 最新合成图常驻内存并落盘 cacheDir/display.jpg，HTTP 直接下载；
 * MQTT 发布由上传方（浏览器，复用放映联动的 MQTT 连接）按返回的 topic 完成，
 * 消息结构与 LED 四屏协议完全一致（led-display/1.0），便于板端复用解析。
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'

const ROLES = ['main', 'secondary']
const WIDTH = 1280
const HEIGHT = 800
const HALF_WIDTH = 640

export function createMonitorService({ cacheDir }) {
  const halves = { main: null, secondary: null }
  let revision = 0
  let jpeg = null
  let sha256 = ''
  let updatedAt = null

  // 页码角标字体：使用部署包捆绑的 MiSans（server/assets/fonts/，仓库内为 src/assets/fonts/）
  for (const fontPath of [
    path.resolve(cacheDir, '../../server/assets/fonts/MiSans.woff2'),
    path.resolve(cacheDir, '../../src/assets/fonts/MiSans.woff2'),
  ]) {
    try {
      if (fs.existsSync(fontPath)) {
        GlobalFonts.registerFromPath(fontPath, 'MonitorUI')
        break
      }
    }
    catch { /* 尝试下一个候选路径 */ }
  }

  async function composite() {
    const canvas = createCanvas(WIDTH, HEIGHT)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0d1524'
    ctx.fillRect(0, 0, WIDTH, HEIGHT)

    for (const [role, x] of [['main', 0], ['secondary', HALF_WIDTH]]) {
      const half = halves[role]
      if (half?.buffer) {
        try {
          const img = await loadImage(half.buffer)
          const scale = Math.min(HALF_WIDTH / img.width, HEIGHT / img.height)
          const w = img.width * scale
          const h = img.height * scale
          ctx.drawImage(img, x + (HALF_WIDTH - w) / 2, (HEIGHT - h) / 2, w, h)
        }
        catch { /* 半区绘制失败按占位处理 */ }
      }
      else {
        ctx.fillStyle = '#111827'
        ctx.fillRect(x, 0, HALF_WIDTH, HEIGHT)
        ctx.fillStyle = '#64748b'
        ctx.font = '28px "MonitorUI", sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(role === 'main' ? '等待主屏画面' : '等待副屏画面', x + HALF_WIDTH / 2, HEIGHT / 2)
        ctx.textAlign = 'left'
      }
    }

    // 中缝分隔线
    ctx.fillStyle = 'rgba(148,163,184,.35)'
    ctx.fillRect(HALF_WIDTH - 1, 0, 2, HEIGHT)

    // 页码角标：主屏左上、副屏右上
    ctx.font = 'bold 46px "MonitorUI", sans-serif'
    ctx.shadowColor = 'rgba(0,0,0,.85)'
    ctx.shadowBlur = 10
    ctx.fillStyle = '#ffffff'
    if (halves.main) ctx.fillText(`${halves.main.page}/${halves.main.total}`, 18, 58)
    if (halves.secondary) {
      ctx.textAlign = 'right'
      ctx.fillText(`${halves.secondary.page}/${halves.secondary.total}`, WIDTH - 18, 58)
      ctx.textAlign = 'left'
    }
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0

    jpeg = canvas.toBuffer('image/jpeg', 82)
    sha256 = crypto.createHash('sha256').update(jpeg).digest('hex')
    revision++
    updatedAt = Date.now()
    try {
      await fsp.mkdir(cacheDir, { recursive: true })
      await fsp.writeFile(path.join(cacheDir, 'display.jpg'), jpeg)
    }
    catch { /* 内存中仍保留最新合成图 */ }
  }

  async function applyHalf(role, { image, page, total }) {
    if (!ROLES.includes(role)) throw new Error('未知画面角色')
    const base64 = String(image || '')
    const comma = base64.indexOf(',')
    const buffer = Buffer.from(comma >= 0 ? base64.slice(comma + 1) : base64, 'base64')
    if (!buffer.length) throw new Error('画面数据为空')
    halves[role] = { buffer, page: Math.max(1, Number(page) || 1), total: Math.max(1, Number(total) || 1) }
    await composite()
    return status()
  }

  function status() {
    return {
      revision,
      sha256,
      width: WIDTH,
      height: HEIGHT,
      updatedAt,
      url: '/monitor-api/display',
      mainPage: halves.main ? `${halves.main.page}/${halves.main.total}` : null,
      secondaryPage: halves.secondary ? `${halves.secondary.page}/${halves.secondary.total}` : null,
    }
  }

  function displayJpeg() { return jpeg }

  async function init() {
    await fsp.mkdir(cacheDir, { recursive: true })
    const file = path.join(cacheDir, 'display.jpg')
    if (await fsp.stat(file).catch(() => null)) {
      jpeg = await fsp.readFile(file)
      sha256 = crypto.createHash('sha256').update(jpeg).digest('hex')
      updatedAt = Date.now()
    }
  }

  return { init, applyHalf, status, displayJpeg }
}
