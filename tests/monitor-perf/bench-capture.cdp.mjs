/* eslint-disable no-console */
/**
 * 量化双屏监控截图耗时：html-to-image 默认(嵌入全部@font-face) vs skipFonts。
 * 真实生产环境复刻：dist 构建产物的 20 个字体声明 + 真实页面底图 + MiSans 文本。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'

const root = path.resolve(import.meta.dirname, '../..')
const PORT = 18801
const CDP_PORT = 19241

// 找一个真实整页底图（png，1-3MB 量级）
const assetsDir = path.join(root, 'data/default-ppt/assets')
const pageImg = fs.readdirSync(assetsDir)
  .map(f => ({ f, s: fs.statSync(path.join(assetsDir, f)).size }))
  .filter(x => x.f.endsWith('.png') && x.s > 300_000 && x.s < 4_000_000)
  .sort((a, b) => b.s - a.s)[0]?.f
if (!pageImg) { console.error('找不到样本底图'); process.exit(1) }
console.log('样本底图:', pageImg, (fs.statSync(path.join(assetsDir, pageImg)).size / 1e6).toFixed(1) + 'MB')
// 取真实 GIF 覆盖层（限制在 ~40MB，避免 134MB 样本撑爆测试进程）
const gifFile = fs.readdirSync(assetsDir)
  .map(f => ({ f, s: fs.statSync(path.join(assetsDir, f)).size }))
  .filter(x => x.f.endsWith('.gif') && x.s > 5_000_000 && x.s <= 45_000_000)
  .sort((a, b) => b.s - a.s)[0]?.f
if (!gifFile) { console.error('找不到样本 GIF'); process.exit(1) }
console.log('样本 GIF:', gifFile, (fs.statSync(path.join(assetsDir, gifFile)).size / 1e6).toFixed(1) + 'MB')

// 提取构建 CSS 中的全部 @font-face 规则（生产 DOM 里就是这些声明）
const cssFile = fs.readdirSync(path.join(root, 'dist/assets')).filter(f => f.endsWith('.css'))[0]
const css = fs.readFileSync(path.join(root, 'dist/assets', cssFile), 'utf8')
const fontFaces = (css.match(/@font-face\{[^}]*\}/g) || []).join('\n')
console.log('font-face 声明数:', (css.match(/@font-face\{/g) || []).length)

const mime = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  const send = (file, type) => {
    try {
      const data = fs.readFileSync(file)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400, immutable', 'Content-Length': data.length })
      res.end(data)
    }
    catch { res.writeHead(404); res.end() }
  }
  const url = req.url.split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces}</style></head>
<body><div id="slide" style="width:960px;height:540px;position:relative;background:#101522">
<img src="/img/page.png" style="width:100%;height:100%;object-fit:cover">
<div id="gifwrap" style="position:absolute;left:600px;top:280px;width:330px;height:230px">
<img id="gif" src="/img/anim.gif" style="width:100%;height:100%;object-fit:contain">
</div>
<div style="position:absolute;left:40px;top:40px;font-size:34px;font-family:MiSans;color:#fff;text-shadow:0 2px 8px #000">行车数据可信治理与事故判责平台</div>
<div style="position:absolute;left:40px;top:90px;font-size:20px;font-family:MiSans;color:#cfe6ff">汇报人：智证先锋 · 2026</div>
</div>
<script src="/h2i.js"></script></body></html>`)
  }
  else if (url === '/h2i.js') send(path.join(root, 'node_modules/html-to-image/dist/html-to-image.js'), 'application/javascript')
  else if (url === '/img/page.png') send(path.join(assetsDir, pageImg), 'image/png')
  else if (url === '/img/anim.gif') send(path.join(assetsDir, gifFile), 'image/gif')
  else if (/\.woff2$/.test(url)) {
    // @font-face 用相对 url(./Xxx-hash.woff2)，<style> 内相对文档根解析
    send(path.join(root, 'dist/assets', url.slice(1)), 'font/woff2')
  }
  else if (url.startsWith('/assets/')) {
    const f = path.join(root, 'dist/assets', url.slice('/assets/'.length))
    send(f, mime[path.extname(f)] || 'application/octet-stream')
  }
  else { res.writeHead(404); res.end() }
})
server.listen(PORT)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-mon-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' })

const waitWs = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    }
    catch {}
    await sleep(300)
  }
  throw new Error('CDP 未就绪')
}
const ws = new WebSocket(await waitWs(), { maxPayload: 512 * 1024 * 1024 })
await new Promise(r => ws.once('open', r))
let seq = 0
const pending = new Map()
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
const send = (method, params = {}) => new Promise(resolve => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) return 'EVAL_ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300)
  return r.result?.result?.value
}
await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3500)

const result = await evaluate(`(async () => {
  const h2i = window.htmlToImage
  const el = document.getElementById('slide')
  await new Promise(r => requestAnimationFrame(r))
  const out = []
  const run = async (mode, opts) => {
    for (let i = 0; i < 2; i++) {
      const t = performance.now()
      const d = await h2i.toJpeg(el, { pixelRatio: 0.65, quality: 0.78, backgroundColor: '#101522', ...opts })
      out.push({ mode, run: i + 1, ms: Math.round(performance.now() - t), bytes: d.length })
    }
  }
  await run('default(含GIF嵌入)', {})
  await run('skipFonts(仍含GIF)', { skipFonts: true })
  await run('filter跳过GIF(优化后)', { filter: n => !(n instanceof HTMLImageElement && /\\.gif(\\?|$)/i.test(n.src || '')) })
  return out
})()`)
console.log('\n=== toJpeg 耗时对比（640×800 半区参数） ===')
if (typeof result === 'string') console.log(result)
else result.forEach(r => console.log(`${r.mode.padEnd(22)} 第${r.run}次: ${String(r.ms).padStart(5)}ms  产物${(r.bytes / 1024).toFixed(0)}KB`))

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
server.close()
process.exit(0)
