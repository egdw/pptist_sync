/* eslint-disable no-console */
/**
 * 方向盘测试台 E2E（真实硬件）：无头 Chrome 打开 /wheel，
 * 验证连接真实 G29 服务(192.168.2.8:8000)并渲染实时数据。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const PORT = process.env.PORT || 18981
const CDP_PORT = 19251
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-wheel-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userData}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1280,900', 'about:blank',
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
const ws = new WebSocket(await waitWs(), { maxPayload: 64 * 1024 * 1024 })
await new Promise(r => ws.once('open', r))
let seq = 0
const pending = new Map()
ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/wheel` })
await sleep(4000)

const snap = () => evaluate(`({
  dot: document.getElementById('dot')?.className || '',
  statusText: document.getElementById('hz')?.textContent || '',
  angle: document.getElementById('angle')?.textContent,
  norm: document.getElementById('norm')?.textContent,
  thrV: document.getElementById('thrV')?.textContent,
  brkV: document.getElementById('brkV')?.textContent,
  rate: document.getElementById('rate')?.textContent,
  dev: document.getElementById('dev')?.textContent,
  health: document.getElementById('health')?.textContent,
  lag: document.getElementById('lag')?.textContent,
})`)

const s1 = await snap()
await sleep(2000)
const s2 = await snap()
console.log('连接状态:', JSON.stringify(s1))
console.log('2秒后:', JSON.stringify(s2))

let pass = true
const ok = (cond, name) => { console.log((cond ? '✓' : '✗ FAIL'), name); if (!cond) pass = false }
ok(s1.dot.includes('ok'), 'WebSocket 已连接真实 G29 服务')
ok(s2.rate && s2.rate.includes('Hz'), `消息频率正常: ${s2.rate}`)
ok(s1.dev?.includes('G29'), `设备名渲染: ${s1.dev}`)
ok(s1.health?.includes('ok'), `健康检查: ${s1.health}`)
ok(s1.angle !== undefined && !Number.isNaN(parseFloat(s1.angle)), `转向角度渲染: ${s1.angle}°`)
ok(s1.thrV?.includes('%') && s1.brkV?.includes('%'), `踏板渲染: 油${s1.thrV} 刹${s1.brkV}`)
ok(s1.lag !== '—', `数据时延显示: ${s1.lag}`)

// 先让页面干净断开 WS（台架服务对 abrupt 断开会挂起），再杀浏览器
await send('Runtime.evaluate', { expression: 'window.close?.(), ""' }).catch(() => {})
chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
setTimeout(() => process.exit(pass ? 0 : 1), 400)
