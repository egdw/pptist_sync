/* eslint-disable no-console */
/**
 * 双屏联动浸泡测试：模拟长时间高强度使用，验证服务端无泄漏。
 * - 300 次控制器/副屏连接建立与销毁（角色注册→心跳→断开）
 * - 2000 次 PING/PONG 心跳
 * - 200 轮 NAVIGATE/ACK 切页往返（commandId 幂等）
 * - 200 次监控半区上传合成
 * 全程采样 showflow-ws clients 表大小与服务端 RSS。
 */
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import WebSocket from 'ws'

const PORT = 18990
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'pptist-soak-'))
const child = spawn(process.execPath, [path.resolve('server/pptist-server.mjs')], {
  env: { ...process.env, PPTIST_PORT: String(PORT), PPTIST_REMOTE_API: '', PPTIST_DATA_DIR: path.join(dataDir, 'main'), PPTIST_SECONDARY_DATA_DIR: path.join(dataDir, 'sec'), PPTIST_DIST_DIR: dataDir, PPTIST_GIF_VIDEO_MB: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', d => process.stderr.write('[server] ' + d))
child.stdout.on('data', d => process.stdout.write('[server-out] ' + d))
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/default-ppt-api/config`)).ok) break } catch {}
  await sleep(100)
}

const rss = () => Number(spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`], { encoding: 'utf8' }).stdout.trim() || 0) / 1048576
const wsStatus = async () => (await (await fetch(`${BASE}/api/studio/system/status`)).json()).websocket

const send = (ws, msg) => ws.send(JSON.stringify(msg))
const waitMsg = (ws, type, timeout = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待 ' + type + ' 超时')), timeout)
  const on = raw => {
    const msg = JSON.parse(raw.toString())
    if (msg.type === type) { clearTimeout(timer); ws.off('message', on); resolve(msg) }
  }
  ws.on('message', on)
})

// ---- 阶段 1: 300 次连接生命周期 ----
let rss0 = rss()
for (let i = 0; i < 300; i++) {
  const c = new WebSocket(`ws://127.0.0.1:${PORT}/showflow`)
  await new Promise(r => c.once('open', r))
  send(c, { type: 'HELLO', role: 'controller' })
  await waitMsg(c, 'HELLO_ACK')
  send(c, { type: 'PING', role: 'controller' })
  send(c, { type: 'PING', role: 'controller' })
  await sleep(2)
  c.close()
  if (i % 100 === 99) await sleep(150) // 让 close 事件走完
}
await sleep(600)
let s1 = await wsStatus()
let rss1 = rss()
console.log(`阶段1 300次连接: clients=${s1.totalConnections}(应≈0) RSS ${rss0.toFixed(0)}→${rss1.toFixed(0)}MB (+${(rss1 - rss0).toFixed(0)})`)

// ---- 阶段 2: 2000 次心跳 + 200 轮切页 ----
const controller = new WebSocket(`ws://127.0.0.1:${PORT}/showflow`)
await new Promise(r => controller.once('open', r))
send(controller, { type: 'HELLO', role: 'controller' })
await waitMsg(controller, 'HELLO_ACK')
const secondary = new WebSocket(`ws://127.0.0.1:${PORT}/showflow`)
await new Promise(r => secondary.once('open', r))
send(secondary, { type: 'HELLO', role: 'secondary' })
await waitMsg(secondary, 'HELLO_ACK')
await sleep(100)

secondary.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.type === 'NAVIGATE') send(secondary, { type: 'ACK', commandId: msg.commandId, pageId: msg.pageId, rendered: true })
})
for (let i = 0; i < 2000; i++) {
  send(controller, { type: 'PING', role: 'controller' })
  send(secondary, { type: 'PING', role: 'secondary' })
  if (i % 200 === 0) await sleep(30)
}
for (let i = 0; i < 200; i++) {
  send(controller, { type: 'NAVIGATE', commandId: `soak-${i}`, pageId: `p${i}`, role: 'secondary' })
  if (i % 50 === 0) await sleep(20)
}
await sleep(500)
let s2 = await wsStatus()
let rss2 = rss()
console.log(`阶段2 2000心跳+200切页: clients=${s2.totalConnections}(应=2) RSS ${rss1.toFixed(0)}→${rss2.toFixed(0)}MB (+${(rss2 - rss1).toFixed(0)})`)

// ---- 阶段 3: 200 次监控半区合成 ----
const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABAEBAQAAAAAAAAAAAAAAAAAAAAYQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAC0AUADASIAAhEAAxEA/9oADAMBAAIRAxEAPwCUBRp0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB//2Q=='
for (let i = 0; i < 200; i++) {
  await fetch(`${BASE}/monitor-api/screen/main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: (i % 40) + 1, total: 40, image: tinyJpeg }),
  })
  if (i % 50 === 0) await sleep(20)
}
await sleep(400)
let s3 = await wsStatus()
let rss3 = rss()
console.log(`阶段3 200次合成: RSS ${rss2.toFixed(0)}→${rss3.toFixed(0)}MB (+${(rss3 - rss2).toFixed(0)})`)

// ---- 阶段 4: 损坏图片应被拒绝且进程存活 ----
  const bad = await fetch(`${BASE}/monitor-api/screen/main`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1, total: 40, image: 'data:image/jpeg;base64,' + Buffer.alloc(200, 0x41).toString('base64') }),
  })
  const aliveAfterBad = await fetch(`${BASE}/default-ppt-api/config`)
  let pass = s1.totalConnections <= 2 && s2.totalConnections === 2 && (rss3 - rss1) < 120 && bad.status === 400 && aliveAfterBad.ok
  console.log(`阶段4 损坏图片: ${bad.status}(应400) 服务存活=${aliveAfterBad.ok}`)

// ---- 阶段 5: 超限巨消息应被丢弃且服务存活 ----
  controller.close(); secondary.close()
  await sleep(300)
  const flood = new WebSocket(`ws://127.0.0.1:${PORT}/showflow`)
  await new Promise(r => flood.once('open', r))
  send(flood, { type: 'HELLO', role: 'controller' })
  await waitMsg(flood, 'HELLO_ACK')
  const closed = new Promise(r => flood.once('close', r))
  try { flood.send(Buffer.alloc(2 * 1024 * 1024, 0x41)) } catch {}
  await Promise.race([closed, sleep(3000)])
  const aliveAfterFlood = await fetch(`${BASE}/default-ppt-api/config`)
  pass = pass && aliveAfterFlood.ok
  console.log(`阶段5 巨消息: 服务存活=${aliveAfterFlood.ok}`)
await sleep(300)

console.log(`\n浸泡结论: ${pass ? '✓ 无泄漏(clients 表归零/稳定, RSS 增长有界)' : '✗ 需要进一步排查'}`)
child.kill()
try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch {}
setTimeout(() => process.exit(pass ? 0 : 1), 500)
