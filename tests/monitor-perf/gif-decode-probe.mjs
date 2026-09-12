/* eslint-disable no-console */
/**
 * GIF 动画探针：页面全窗展示 GIF，CDP 截图两次对比像素是否变化。
 * （canvas drawImage 对动图只画首帧，不能用于判定动画）
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const PORT = 18803
const CDP_PORT = 19243
const srcDir = process.env.GIF_DIR || 'C:/Users/egdw/AppData/Local/Temp/zz2/ppt/media'
const gifs = fs.readdirSync(srcDir).filter(f => /\.gif$/i.test(f))
  .map(f => ({ f, size: fs.statSync(path.join(srcDir, f)).size }))
  .sort((a, b) => b.size - a.size)

const server = http.createServer((req, res) => {
  const f = decodeURIComponent(req.url.slice(1))
  if (!f || f === 'favicon.ico') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<body>probe</body>'); return }
  try {
    const data = fs.readFileSync(path.join(srcDir, f))
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': data.length, 'Cache-Control': 'immutable' })
    res.end(data)
  }
  catch { res.writeHead(404); res.end() }
})
server.listen(PORT)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-gifdec-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`,
  '--headless=new', '--no-first-run', '--window-size=800,450', 'about:blank',
], { stdio: 'ignore' })
await sleep(2500)
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.once('open', r))
let seq = 0
const pending = new Map()
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const shot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'jpeg', quality: 60 })).result.data, 'base64')
await send('Page.enable')

console.log('GIF 文件 | 大小 | 截图对比动画')
for (const { f, size } of gifs) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/probe-${encodeURIComponent(f)}` })
  await sleep(600)
  await evaluate(`(async () => {
    const img = new Image()
    img.src = location.pathname.slice(1)
    try { await img.decode() } catch (e) { return }
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000'
    document.body.appendChild(img)
    await new Promise(r => setTimeout(r, 300))
  })()`)
  await sleep(400)
  const a = crypto.createHash('sha256').update(await shot()).digest('hex')
  await sleep(1600)
  const b = crypto.createHash('sha256').update(await shot()).digest('hex')
  console.log(`${f} | ${(size / 1e6).toFixed(1)}MB | ${a === b ? '否(静止)' : '是(动画)'}`)
}

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
server.close()
process.exit(0)
