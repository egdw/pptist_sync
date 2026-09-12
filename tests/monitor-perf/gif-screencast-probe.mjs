/* eslint-disable no-console */
/**
 * GIF 动画探针 v2（screencast 版）：Page.startScreencast 强制无头合成器连续出帧，
 * 动图才会真实推进；对比首尾帧哈希。先在已知动画的 pdfjs spinner 上自校准。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import WebSocket from 'ws'

const PORT = 18805
const CDP_PORT = 19245
const srcDir = process.env.GIF_DIR || 'C:/Users/egdw/AppData/Local/Temp/zz2/ppt/media'
const control = 'node_modules/pdfjs-dist/web/images/loading-icon.gif'
const gifs = [{ f: '__control_spinner.gif', size: 2545, control: true }]
for (const f of fs.readdirSync(srcDir).filter(f => /^image\d+\.gif$/i.test(f))) {
  gifs.push({ f, size: fs.statSync(path.join(srcDir, f)).size })
}

const server = http.createServer((req, res) => {
  const f = decodeURIComponent(req.url.slice(1))
  const file = f === '__control_spinner.gif' ? path.resolve(control) : path.join(srcDir, f)
  try {
    const data = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': data.length, 'Cache-Control': 'immutable' })
    res.end(data)
  }
  catch { res.writeHead(404); res.end() }
})
server.listen(PORT)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-gifsc-'))
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
const frames = []
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Page.screencastFrame') {
    frames.push(m.params.data)
    ws.send(JSON.stringify({ id: ++seq + 100000, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }))
  }
})
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Page.enable')

console.log('GIF 文件 | 大小 | screencast 首尾帧对比')
for (const { f, size } of gifs) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/p-${encodeURIComponent(f)}` })
  await sleep(500)
  await evaluate(`(async () => {
    const img = new Image()
    img.src = location.pathname.slice(1)
    try { await img.decode() } catch { return }
    img.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000'
    document.body.appendChild(img)
    await new Promise(r => setTimeout(r, 300))
  })()`)
  frames.length = 0
  await send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 4 })
  await sleep(2500)
  await send('Page.stopScreencast')
  if (frames.length < 2) { console.log(`${f} | ${(size / 1e6).toFixed(1)}MB | 帧不足(${frames.length})`); continue }
  const h = s => crypto.createHash('sha256').update(Buffer.from(s, 'base64')).digest('hex')
  console.log(`${f} | ${(size / 1e6).toFixed(1)}MB | ${frames.length}帧 ${h(frames[0]) === h(frames[frames.length - 1]) ? '否(静止)' : '是(动画)'}`)
}

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
server.close()
process.exit(0)
