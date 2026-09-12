/* eslint-disable no-console */
/**
 * 大 GIF 驻留内存探针：headless Chrome 加载真实 134MB GIF 循环播放，
 * 每 20s 采样本实例 chrome 进程树 RSS，观察是否持续增长（空闲卡死根因验证）。
 */
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'

const root = path.resolve(import.meta.dirname, '../..')
const PORT = 18802
const CDP_PORT = 19242
const gif = 'e41e0f44031f625e434110bf6872137ef5d2097b905112ff5f01da3480878e6f.gif' // 134MB
const png = fs.readdirSync(path.join(root, 'data/default-ppt/assets')).find(f => f.endsWith('.png'))

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(`<img id="target" src="/static.png" style="width:960px;height:540px;object-fit:contain">`)
  }
  else if (url === '/anim.gif') {
    const data = fs.readFileSync(path.join(root, 'data/default-ppt/assets', gif))
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': data.length, 'Cache-Control': 'immutable' })
    res.end(data)
  }
  else if (url === '/static.png') {
    const data = fs.readFileSync(path.join(root, 'data/default-ppt/assets', png))
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length, 'Cache-Control': 'immutable' })
    res.end(data)
  }
  else { res.writeHead(404); res.end() }
})
server.listen(PORT)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-gif-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' })
await sleep(2500)

// 按进程树聚合本 headless 实例的 chrome 进程内存（排除用户自己的 Chrome）
const chromeRootPid = chrome.pid
const rssMB = () => {
  const csv = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\'\\" | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation"',
    { encoding: 'utf8' },
  )
  const rows = []
  const re = /"(\d+)","(\d+)","(\d+)"/g
  for (const line of csv.split('\n')) {
    re.lastIndex = 0
    const m = re.exec(line)
    if (m) rows.push({ pid: +m[1], ppid: +m[2], ws: +m[3] })
  }
  const tree = new Set([chromeRootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); changed = true }
  }
  return rows.filter(r => tree.has(r.pid)).reduce((a, b) => a + b.ws, 0) / 1048576
}

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl)
await new Promise(r => ws.once('open', r))
let seq = 0
const pending = new Map()
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(3000)

console.log('阶段1: 静态 PNG 驻留 60s（基线）')
for (let i = 0; i < 3; i++) { await sleep(20000); console.log(`  ${20 * (i + 1)}s: RSS ${rssMB().toFixed(0)} MB`) }

console.log('阶段2: 切换为 134MB GIF 循环播放，观察 240s')
await evaluate(`document.getElementById('target').src = '/anim.gif'`)
const t0 = Date.now()
let prev = rssMB()
for (let i = 0; i < 12; i++) {
  await sleep(20000)
  const now = rssMB()
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s: ${now.toFixed(0)} MB (${now >= prev ? '+' : ''}${(now - prev).toFixed(0)})`)
  prev = now
}

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
server.close()
process.exit(0)
