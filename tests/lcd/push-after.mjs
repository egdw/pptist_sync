/* eslint-disable no-console */
/**
 * LCD 推送优化后复测：内容寻址缓存 + 服务端代发布 + 去重 + 掉线行为。
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
import * as WS from 'ws'

const require = createRequire(import.meta.url)
const AedesMod = await import(pathToFileURL(require.resolve('aedes', { paths: ['C:/Users/egdw/AppData/Local/Temp/lcd-broker/node_modules'] })).href)
const MQTT_PATH = path.resolve('server/node_modules/mqtt/build/index.js')
const mqtt = (await import(pathToFileURL(MQTT_PATH).href)).default

const BROKER_PORT = 18885
const PORT = 18985
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'lcd-after-'))

// ---- broker（可通过关闭 WebSocket 服务模拟掉线） ----
const aedes = await AedesMod.Aedes.createBroker()
const brokerServer = createServer()
const wss = new WS.WebSocketServer({ server: brokerServer, path: '/mqtt' })
wss.on('connection', ws => aedes.handle(WS.createWebSocketStream(ws)))
await new Promise(r => brokerServer.listen(BROKER_PORT, r))

console.log('[step] broker up')
const received = []
const board = mqtt.connect(`ws://127.0.0.1:${BROKER_PORT}/mqtt`, { clientId: 'board-after' })
await new Promise(r => board.on('connect', r))
board.subscribe('presentation/led/+/display')
board.on('message', (topic, payload) => received.push({ topic, at: performance.now(), msg: JSON.parse(payload.toString()) }))

// ---- 服务端（配置 MQTT 指向本地 broker） ----
await fsp.mkdir(path.join(dataDir, 'config'), { recursive: true })
await fsp.writeFile(path.join(dataDir, 'config', 'presentation-link.json'), JSON.stringify({
  mqtt: { enabled: true, url: `ws://127.0.0.1:${BROKER_PORT}/mqtt`, username: '', password: '', qos: 1 },
  ws: { enabled: false, url: '' },
}))
const server = spawn(process.execPath, [path.resolve('server/pptist-server.mjs')], {
  env: { ...process.env, PPTIST_PORT: String(PORT), PPTIST_REMOTE_API: '', PPTIST_DATA_DIR: path.join(dataDir, 'main'), PPTIST_SECONDARY_DATA_DIR: path.join(dataDir, 'sec'), PPTIST_DIST_DIR: dataDir, PPTIST_PRESENTATION_LINK_CONFIG_FILE: path.join(dataDir, 'config', 'presentation-link.json'), PPTIST_LED_CACHE_DIR: path.join(dataDir, 'led-cache') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/default-ppt-api/config`)).ok) break } catch {}
  await sleep(100)
}
await sleep(2500) // 等 MQTT 连接建立

console.log('[step] server ready + mqtt wait done')
const state = i => ({
  stage: `环节${i}`, active: ['manager'], lead: 'manager',
  roles: { manager: { task: `任务A${i}` }, platform: { task: '任务B' }, twin: { task: '任务C' }, hardware: { task: '任务D' } },
})
const render = (s, publish = false) => fetch(`${BASE}/led-render-api/render`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: s, ...(publish ? { publish: true } : {}) }),
}).then(r => r.json())

// 1) 服务端代发布: 板端直接收到 4 条(无需浏览器参与)
let t0 = performance.now()
const r1 = await render(state(1), true)
await sleep(400)
console.log(`服务端代发布: published=${r1.published} 板端收到 ${received.length} 条, 端到端 ${(performance.now() - t0).toFixed(0)}ms`)
const url1 = r1.screens[0].url

console.log('[step] scenario1 done')
// 2) 相同状态重访: 渲染缓存命中(同 URL 同 sha) + 不重复发布
received.length = 0
t0 = performance.now()
const r2 = await render(state(1), true)
await sleep(300)
console.log(`相同状态重访: ${((performance.now() - t0)).toFixed(0)}ms(含等待), URL 不变=${r2.screens[0].url === url1}, 板端新消息 ${received.length} 条(retain 重复下发, 板端按 sha 可跳过下载)`)

// 3) 不同状态: 正常下发
received.length = 0
await render(state(2), true)
await sleep(300)
console.log(`不同状态: 板端新消息 ${received.length} 条(应4)`)

// 4) 板端下载: 相同 URL 二次下载走 immutable 缓存
const dl = await fetch(BASE + new URL(url1).pathname)
console.log(`板端下载: ${(dl.headers.get('content-length') / 1024).toFixed(0)}KB, cache-control=${dl.headers.get('cache-control')?.slice(0, 40)}`)

await board.end(false)
wss.clients.forEach(c => c.terminate())   // 服务端发布器仍连着: 必须强断, 否则 close 永不回调
brokerServer.close()
await sleep(500)

console.log('[step] scenario4 done')
// 5) broker 掉线: 服务端发布器 pending+重试, 不丢消息; broker 恢复后送达
received.length = 0
const rp = render(state(3), true)
await sleep(300)
// broker 重启（全新 aedes 实例——旧实例被强断后状态不再可靠）
const aedes2 = await AedesMod.Aedes.createBroker()
const brokerServer2 = createServer()
const wss2 = new WS.WebSocketServer({ server: brokerServer2, path: '/mqtt' })
wss2.on('connection', ws => aedes2.handle(WS.createWebSocketStream(ws)))
await new Promise(r => brokerServer2.listen(BROKER_PORT, r))
const board2 = mqtt.connect(`ws://127.0.0.1:${BROKER_PORT}/mqtt`, { clientId: 'board-after2' })
await new Promise(r => board2.on('connect', r))
board2.subscribe('presentation/led/+/display')
board2.on('message', (topic, payload) => received.push({ topic, at: performance.now(), msg: JSON.parse(payload.toString()) }))
const r3 = await rp
await sleep(2500)
console.log(`掉线恢复: published=${JSON.stringify(r3.published)}(应'queued'), 板端(重连后)收到 ${received.length} 条(应4, 重试补偿送达)`)

await board2.end(false)
wss2.clients.forEach(c => c.terminate())
brokerServer2.close()
server.kill()
try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
setTimeout(() => process.exit(0), 400)
