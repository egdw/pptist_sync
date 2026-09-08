/* eslint-env node */
/* eslint-disable no-console */
/**
 * 主屏 v3 资源化上传 · 服务端端到端测试（可用真实 500MB PPTX）：
 *   node tests/default-ppt-v3/run.mjs                （合成资产 + 小 raw）
 *   node tests/default-ppt-v3/run.mjs --big "D:/智证修改版.pptx"   （真实 500MB 原始文件流）
 *
 * 覆盖：会话创建 / 资产上传(哈希命名+秒传去重) / raw 流式 / bundle 校验
 * （拒绝 data:、blob:、缺失资产）/ commit 原子发布 / /current/slides 输出
 * / 资产 immutable 缓存 + ETag 304 / 版本化 bundle / 版本保留策略 / 重启持久化
 * / 服务端内存有界（--big 时打印 RSS 变化）
 */
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, statSync, readdirSync, createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const args = process.argv.slice(2)
const bigIdx = args.indexOf('--big')
const BIG_FILE = bigIdx >= 0 ? path.resolve(args[bigIdx + 1]) : null
const PORT = 18971
const BASE = `http://127.0.0.1:${PORT}`

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64')

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗ FAIL:', name) } }
const wait = ms => new Promise(r => setTimeout(r, ms))

const dataDir = mkdtempSync(path.join(tmpdir(), 'pptist-v3-test-'))
let child = null, serverLog = ''

async function startServer() {
  child = spawn(process.execPath, [path.resolve('server/pptist-server.mjs')], {
    env: { ...process.env, PPTIST_PORT: String(PORT), PPTIST_REMOTE_API: '', PPTIST_DATA_DIR: path.join(dataDir, 'default-ppt'), PPTIST_SECONDARY_DATA_DIR: path.join(dataDir, 'secondary-ppt'), PPTIST_DIST_DIR: path.join(dataDir, 'dist'), PPTIST_MAX_UPLOAD_MB: '2048' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', b => { serverLog += b })
  child.stderr.on('data', b => { serverLog += b })
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/default-ppt-api/config`)).ok) return } catch {}
    await wait(100)
  }
  throw new Error('server start failed: ' + serverLog)
}
async function stopServer() {
  if (!child || child.exitCode !== null) return
  child.kill()
  await new Promise(r => child.once('exit', r))
}
const serverRSS = () => Number(spawnSyncOut('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).WorkingSet64`]))

function spawnSyncOut(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8' })
  return (r.stdout || '').trim()
}

async function jsonOf(r) { return r.json().catch(() => null) }

async function fullUpload({ filename, assets, slidesSkeleton, rawSource, rawName }) {
  const created = await fetch(`${BASE}/default-ppt-api/upload-sessions`, { method: 'POST' })
  const { sessionId } = await jsonOf(created)
  const sessionUrl = `${BASE}/default-ppt-api/upload-sessions/${sessionId}`
  const srcMap = new Map()
  for (const a of assets) {
    const put = await fetch(`${sessionUrl}/assets`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Asset-Ext': a.ext }, body: a.data })
    const result = await jsonOf(put)
    if (!put.ok) throw new Error(`asset put ${put.status}: ${JSON.stringify(result)}`)
    srcMap.set(a.key, `/default-ppt-api/assets/${result.name}`)
    a.deduped = !!result.deduped
  }
  const slides = slidesSkeleton(srcMap)
  const rawPut = await fetch(`${sessionUrl}/raw`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: rawSource, ...(rawSource instanceof ReadableStream ? { duplex: 'half' } : {}) })
  if (!rawPut.ok) throw new Error('raw put ' + rawPut.status)
  const bundlePut = await fetch(`${sessionUrl}/bundle`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: rawName, slides, theme: {}, viewportSize: 1000, viewportRatio: 0.5625 }) })
  if (!bundlePut.ok) throw new Error('bundle put ' + bundlePut.status)
  const commit = await fetch(`${sessionUrl}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, pageCount: slides.length }) })
  const commitResult = await jsonOf(commit)
  if (!commit.ok) throw new Error(`commit ${commit.status}: ${JSON.stringify(commitResult)}`)
  return { commitResult, assets, slides }
}

async function main() {
  await startServer()

  // ---- 1. 会话与资产 ----
  const sha = data => crypto.createHash('sha256').update(data).digest('hex')
  const upload1 = await fullUpload({
    filename: '测试文稿.pptx',
    rawName: '测试文稿',
    assets: [
      { key: 'img1', ext: 'png', data: PNG_1x1 },
      { key: 'img2', ext: 'png', data: PNG_1x1 }, // 与 img1 同字节 → 秒传
      { key: 'gif1', ext: 'gif', data: GIF_1x1 },
    ],
    slidesSkeleton: src => [
      { id: 's1', elements: [{ type: 'image', id: 'e1', src: src.get('img1') }] },
      { id: 's2', elements: [], background: { type: 'image', image: { src: src.get('gif1'), size: 'cover' } } },
    ],
    rawSource: Buffer.concat([PNG_1x1, GIF_1x1]),
  })
  ok(upload1.commitResult.exists === true && upload1.commitResult.version === 'v1', 'commit 发布 v1')
  ok(upload1.assets[0].name === undefined && !upload1.assets[0].deduped, '首传资产写入')
  ok(upload1.assets[1].deduped === true, '相同字节资产秒传去重')
  const assetName = upload1.slides[0].elements[0].src.split('/').pop()
  ok(new RegExp(`^${sha(PNG_1x1)}\\.png$`).test(assetName), '资产按 sha256 命名')

  // ---- 2. 播放读取 ----
  const slidesRes = await fetch(`${BASE}/default-ppt-api/current/slides`)
  const bundle = await slidesRes.json()
  ok(slidesRes.ok && bundle.slides.length === 2 && bundle.slides[0].elements[0].src.startsWith('/default-ppt-api/assets/'), '/current/slides 输出轻结构（src=资产URL）')
  const assetRes = await fetch(`${BASE}${upload1.slides[0].elements[0].src}`)
  ok(assetRes.ok && assetRes.headers.get('cache-control') === 'public, max-age=31536000, immutable', '资产 immutable 缓存头')
  const etag = assetRes.headers.get('etag')
  const asset304 = await fetch(`${BASE}${upload1.slides[0].elements[0].src}`, { headers: { 'If-None-Match': etag } })
  ok(asset304.status === 304, 'ETag 协商 304')
  const versioned = await fetch(`${BASE}/default-ppt-api/versions/v1/bundle.json`)
  ok(versioned.ok && versioned.headers.get('cache-control')?.includes('immutable'), '版本化 bundle immutable')

  // ---- 3. 校验拒绝 ----
  {
    const created = await fetch(`${BASE}/default-ppt-api/upload-sessions`, { method: 'POST' })
    const { sessionId } = await jsonOf(created)
    const sessionUrl = `${BASE}/default-ppt-api/upload-sessions/${sessionId}`
    await fetch(`${sessionUrl}/raw`, { method: 'PUT', body: PNG_1x1 })
    await fetch(`${sessionUrl}/bundle`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: [{ id: 'x', elements: [{ type: 'image', id: 'e', src: 'data:image/png;base64,xxx' }] }] }) })
    const bad = await fetch(`${sessionUrl}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'a.pptx', pageCount: 1 }) })
    ok(bad.status === 400, 'bundle 残留 data: 内嵌资源被拒绝')
    const missing = await fetch(`${sessionUrl}/bundle`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: [{ id: 'x', elements: [{ type: 'image', id: 'e', src: '/default-ppt-api/assets/' + 'a'.repeat(64) + '.png' }] }] }) })
    void missing
    const bad2 = await fetch(`${sessionUrl}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'a.pptx', pageCount: 1 }) })
    ok(bad2.status === 400, '引用未上传资产被拒绝（播放端不会遇到 404 资源）')
  }

  // ---- 4. 真实大文件 raw 流式（可选） ----
  if (BIG_FILE && statSync(BIG_FILE).size > 100 * 1024 * 1024) {
    const size = statSync(BIG_FILE).size
    const rssBefore = serverRSS()
    const t0 = Date.now()
    const big = await fullUpload({
      filename: path.basename(BIG_FILE),
      rawName: '大文件测试',
      assets: [{ key: 'img1', ext: 'png', data: PNG_1x1 }],
      slidesSkeleton: src => [{ id: 's1', elements: [{ type: 'image', id: 'e1', src: src.get('img1') }] }],
      rawSource: Readable.toWeb(createReadStream(BIG_FILE)), // 纯流式 body：测试进程不整读文件
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const rssAfter = serverRSS()
    ok(big.commitResult.version === 'v2', `500MB 级 raw 流式上传并发布 v2（${(size / 1048576).toFixed(0)}MB / ${secs}s）`)
    const growth = (rssAfter - rssBefore) / 1048576
    ok(growth < 600, `服务端内存有界（RSS 增长 ${growth.toFixed(0)}MB < 600MB，未整读文件）`)
    const rawRes = await fetch(`${BASE}/default-ppt-api/current/file`)
    ok(rawRes.ok && Number(rawRes.headers.get('content-length')) === size, '原始文件下载流式（Content-Length 正确）')
    await rawRes.body?.cancel()
  }

  // ---- 5. 版本保留 + 重启持久化 ----
  for (let k = 0; k < 2; k++) {
    await fullUpload({
      filename: `迭代${k}.pptx`, rawName: `it${k}`,
      assets: [{ key: 'i', ext: 'png', data: Buffer.concat([PNG_1x1, Buffer.from([k])]) }],
      slidesSkeleton: src => [{ id: 's', elements: [{ type: 'image', id: 'e', src: src.get('i') }] }],
      rawSource: PNG_1x1,
    })
  }
  const versions = readdirSync(path.join(dataDir, 'default-ppt', 'versions')).filter(v => /^v\d+$/.test(v))
  ok(versions.length === 2, `版本保留最近 2 个（当前 ${versions.join(',')}）`)
  const assetsAfter = readdirSync(path.join(dataDir, 'default-ppt', 'assets')).filter(f => !f.startsWith('.'))
  ok(assetsAfter.length >= 2, '资产池跨版本共享保留')

  await stopServer()
  await startServer()
  const after = await (await fetch(`${BASE}/default-ppt-api/current/slides`)).json()
  ok(after.slides?.length >= 1, '重启后 current/bundle 持久化恢复')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  await stopServer()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main().catch(async error => {
  console.error(error)
  await stopServer()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(1)
})
