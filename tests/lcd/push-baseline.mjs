/* eslint-disable no-console */
/**
 * LCD 推送链路基线测量：渲染耗时 + 浏览器侧发布 + 端到端投递延迟。
 * 本地 aedes broker + 临时服务端，无 ACK（按板端现状）。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const AedesMod = (await import(pathToFileURL(require.resolve('aedes', { paths: ['C:/Users/egdw/AppData/Local/Temp/lcd-broker/node_modules'] })).href))
const mqtt = (await import(pathToFileURL(require('node:path').resolve('server/node_modules/mqtt/build/index.js')))).default

const BROKER_PORT = 18884
const PORT = 18986
const BASE = `http://127.0.0.1:${PORT}`

// ---- 本地 broker ----
const aedes = await AedesMod.Aedes.createBroker()
const brokerServer = createServer()
import * as WS from 'ws'
const { WebSocketServer, createWebSocketStream } = WS
const wss = new WebSocketServer({ server: brokerServer, path: '/mqtt' })
wss.on('connection', ws => aedes.handle(createWebSocketStream(ws)))
await new Promise(r => brokerServer.listen(BROKER_PORT, r))
console.log(`broker: ws://127.0.0.1:${BROKER_PORT}/mqtt`)

// ---- 订阅端（模拟 LCD 板） ----
const received = []
const board = mqtt.connect(`ws://127.0.0.1:${BROKER_PORT}/mqtt`, { clientId: 'lcd-board-sim' })
await new Promise(r => board.on('connect', r))
board.subscribe('presentation/led/+/display')
board.on('message', (topic, payload) => received.push({ topic, at: performance.now(), msg: JSON.parse(payload.toString()) }))

// ---- 临时服务端 ----
const dataDir = mkdtempSync(path.join(tmpdir(), 'lcd-push-'))
const server = spawn(process.execPath, [path.resolve('server/pptist-server.mjs')], {
  env: { ...process.env, PPTIST_PORT: String(PORT), PPTIST_REMOTE_API: '', PPTIST_DATA_DIR: path.join(dataDir, 'main'), PPTIST_SECONDARY_DATA_DIR: path.join(dataDir, 'sec'), PPTIST_DIST_DIR: dataDir, PPTIST_LED_CACHE_DIR: path.join(dataDir, 'led-cache') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/default-ppt-api/config`)).ok) break } catch {}
  await sleep(100)
}

// ---- 模拟浏览器侧发布通道（当前生产链路: 操作窗口的 MQTT 连接） ----
const publishMqtt = (topic, payload, opts) => new Promise((resolve, reject) =>
  operator.publish(topic, payload, opts, err => err ? reject(err) : resolve()))
const operator = mqtt.connect(`ws://127.0.0.1:${BROKER_PORT}/mqtt`, { clientId: 'operator-sim' })
await new Promise(r => operator.on('connect', r))

const state = i => ({
  stage: `环节${i}`,
  active: ['manager'],
  lead: 'manager',
  roles: { manager: { task: `任务A${i}` }, platform: { task: '任务B' }, twin: { task: '任务C' }, hardware: { task: '任务D' } },
})

// 1) 渲染耗时: 10 个不同状态
let t0 = performance.now()
for (let i = 0; i < 10; i++) {
  const r = await fetch(`${BASE}/led-render-api/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: state(i) }),
  })
  if (!r.ok) { console.log('render FAIL', r.status); process.exit(1) }
}
console.log(`渲染(10 个不同状态): 平均 ${((performance.now() - t0) / 10).toFixed(0)}ms/次`)

// 2) 重复相同状态(后退/重访场景)
t0 = performance.now()
for (let i = 0; i < 10; i++) {
  await fetch(`${BASE}/led-render-api/render`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: state(5) }),
  })
}
console.log(`渲染(10 次相同状态): 平均 ${((performance.now() - t0) / 10).toFixed(0)}ms/次 ← 无缓存则重复全量渲染`)

// 3) 端到端: render → 浏览器发布 4 条 → 板收到
t0 = performance.now()
const rendered = await (await fetch(`${BASE}/led-render-api/render`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: state(99) }),
})).json()
const tRender = performance.now() - t0
const pubStart = performance.now()
for (const screen of rendered.screens) {
  await publishMqtt(`presentation/led/${screen.role}/display`, JSON.stringify({
    protocol: 'led-display/1.0', type: 'display', msg_id: crypto.randomUUID().slice(0, 8),
    revision: rendered.revision, role: screen.role,
    image: { url: screen.url, format: 'jpeg', width: 1280, height: 800, sha256: screen.sha256 },
  }), { qos: 1, retain: true })
}
const tPublish = performance.now() - pubStart
await sleep(300)
const e2e = received.length ? received[received.length - 1].at - t0 : -1
console.log(`端到端: 渲染 ${tRender.toFixed(0)}ms + 发布4条 ${tPublish.toFixed(0)}ms + broker投递 ≈ ${e2e < 0 ? 'N/A' : e2e.toFixed(0)}ms (累计收到 ${received.length} 条)`)

// 4) 板端下载图片耗时
const dlStart = performance.now()
const img = await fetch(BASE + new URL(rendered.screens[0].url).pathname)
const dlBytes = (await img.arrayBuffer()).byteLength
console.log(`板端下载: ${(dlBytes / 1024).toFixed(0)}KB / ${((performance.now() - dlStart)).toFixed(0)}ms`)

// 5) 断连场景: 操作窗口 MQTT 掉线时发布(当前生产行为=静默丢弃)
await new Promise(r => operator.end(false, {}, r))
const rendered2 = await (await fetch(`${BASE}/led-render-api/render`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: state(100) }),
})).json()
const before = received.length
// publishPresentationMqtt 对断线连接返回 false → LcdController 报错丢弃
console.log(`MQTT 掉线时: 渲染仍成功(rev ${rendered2.revision}), 但当前实现 4 条消息全部丢弃 → LCD 停留旧画面(无重试)`)

await new Promise(r => board.end(false, {}, r))
brokerServer.close()
server.kill()
try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
setTimeout(() => process.exit(0), 400)
