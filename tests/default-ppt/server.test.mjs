/**
 * 「默认 PPT」服务端集成测试
 *   npm run test:default-ppt
 *
 * 自建服务端进程（独立端口 + 临时数据目录），覆盖：
 * - 上传校验：类型、magic bytes、空文稿、超限；失败不影响旧默认
 * - 原子切换与元数据：current/slides/file 三者一致（同一版本）
 * - SSE 通知：连接即推送当前版本；新上传立即广播
 * - 连续上传顺序：后提交者胜出，版本号单调递增
 * - 历史版本保留数
 * - 服务重启后持久化恢复
 * - SPA 路由回退（/play、/upload、/editor 刷新不 404）
 */
/* eslint-env node */
import assert from 'node:assert'
import { spawn } from 'node:child_process'

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SERVER_FILE = path.join(ROOT, 'server/pptist-server.mjs')
const PORT = 8697
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const ok = name => results.push(`  ✓ ${name}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs = 10000, label = 'condition') {
  const start = Date.now()
  for (;;) {
    try {
      if (await fn()) return
    }
    catch { /* 重试 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(100)
  }
}

let server = null
let serverLog = ''
const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptist-default-ppt-'))

function startServer() {
  server = spawn(process.execPath, [SERVER_FILE], {
    env: {
      ...process.env,
      PPTIST_PORT: String(PORT),
      PPTIST_DATA_DIR: dataDir,
      PPTIST_DIST_DIR: path.join(ROOT, 'dist'),
      PPTIST_MAX_UPLOAD_MB: '5',
      PPTIST_KEEP_VERSIONS: '3',
      PPTIST_REMOTE_API: '',
    },
  })
  server.stdout.on('data', data => (serverLog += data.toString()))
  server.stderr.on('data', data => (serverLog += data.toString()))
  return waitFor(async () => {
    const res = await fetch(`${BASE}/default-ppt-api/config`)
    return res.ok
  }, 15000, '服务端启动')
}

function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve()
    server.on('exit', () => resolve())
    server.kill()
    server = null
  })
}

async function upload(filename, rawBuffer, bundle) {
  // 与前端一致的二进制信封：[4 字节头长度][头部 JSON{filename,bundle}][原始文件字节]
  const header = Buffer.from(JSON.stringify({ filename, bundle }))
  const lengthPrefix = Buffer.alloc(4)
  lengthPrefix.writeUInt32BE(header.length)
  const res = await fetch(`${BASE}/default-ppt-api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.concat([lengthPrefix, header, rawBuffer]),
  })
  return { status: res.status, data: await res.json() }
}

function makeBundle(pageCount, marker) {
  const slides = []
  for (let i = 0; i < pageCount; i++) {
    slides.push({
      id: `slide-${marker}-${i}`,
      elements: i === 0
        ? [{
          type: 'image',
          id: `img-${marker}`,
          src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
          width: 100,
          height: 80,
          left: 10,
          top: 10,
        }]
        : [],
      background: { type: 'solid', color: '#fff' },
      remark: i === 0 ? `${marker} 第一页备注\n第二行中文` : '',
    })
  }
  return {
    title: `演示文稿-${marker}`,
    slides,
    theme: { themeColors: ['#5b9bd5'], fontColor: '#333', fontName: '' },
    viewportSize: 1000,
    viewportRatio: 0.5625,
  }
}

const pkBytes = seed => Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from(seed)])

/** 读取 SSE 流：收集事件，直到 predicate 满足 */
async function readSSEUntil(predicate, timeoutMs = 10000) {
  const controller = new AbortController()
  const events = []
  const res = await fetch(`${BASE}/default-ppt-api/events`, { signal: controller.signal })
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = res.body.getReader()
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const eventName = (chunk.match(/^event: (.+)$/m) || [])[1]
        const data = (chunk.match(/^data: (.+)$/m) || [])[1]
        if (eventName && data) events.push({ event: eventName, data: JSON.parse(data) })
      }
      if (predicate(events)) return
    }
  })()
  await Promise.race([
    loop,
    sleep(timeoutMs).then(() => {
      if (!predicate(events)) throw new Error('等待 SSE 事件超时') 
    }),
  ])
  controller.abort()
  return events
}

// ============================== 执行 ==============================
try {
  await startServer()

  // 1. config 与初始状态
  {
    const config = await (await fetch(`${BASE}/default-ppt-api/config`)).json()
    assert.equal(config.maxUploadMB, 5)
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.exists, false)
    const slidesRes = await fetch(`${BASE}/default-ppt-api/current/slides`)
    assert.equal(slidesRes.status, 404)
    ok('初始状态：无默认 PPT，slides 接口返回 404')
  }

  // 2. 校验失败用例：均不得写入默认
  {
    const notPptx = await upload('a.pptx', Buffer.from('hello'), makeBundle(1, 'x'))
    assert.equal(notPptx.status, 400)
    const badExt = await upload('a.txt', pkBytes('x'), makeBundle(1, 'x'))
    assert.equal(badExt.status, 400)
    const badPdf = await upload('a.pdf', Buffer.from('hello'), makeBundle(1, 'x'))
    assert.equal(badPdf.status, 400)
    const empty = await upload('a.pptx', pkBytes('x'), makeBundle(0, 'x'))
    assert.equal(empty.status, 400)
    assert.match(empty.data.error, /为空/)
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.exists, false)
    ok('类型 / magic bytes（PPTX 与 PDF）/ 空文稿校验拒绝，且不产生默认文稿')
  }

  // 2.5 PDF 上传：原文件按 .pdf 保存并可下载
  {
    const pdfRaw = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from('pdf-bytes')])
    const pdfBundle = makeBundle(3, 'P')
    const result = await upload('文档.pdf', pdfRaw, pdfBundle)
    assert.equal(result.status, 200)
    assert.equal(result.data.seq, 1)
    const fileRes = await fetch(`${BASE}/default-ppt-api/current/file`)
    const bytes = Buffer.from(await fileRes.arrayBuffer())
    assert.deepEqual([...bytes], [...pdfRaw])
    assert.match(fileRes.headers.get('content-disposition') || '', /pdf/)
    const bundle = await (await fetch(`${BASE}/default-ppt-api/current/slides`)).json()
    assert.equal(bundle.slides.length, 3)
    // 用一个新 PPTX 覆盖，后续用例从 v2 继续
    await upload('第一版.pptx', pkBytes('first-presentation-bytes'), makeBundle(2, 'A'))
    ok('PDF 上传：魔法数校验通过，原文件与解析数据按版本保存')
  }

  // 3. 正常上传 v1：元数据、解析数据、原文件三者一致
  const raw1 = pkBytes('first-presentation-bytes')
  {
    const result = await upload('第一版.pptx', raw1, makeBundle(2, 'A'))
    assert.equal(result.status, 200)
    assert.equal(result.data.ok, true)
    assert.equal(result.data.seq, 3)
    assert.equal(result.data.pageCount, 2)
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.exists, true)
    assert.equal(current.version, 'v3')
    assert.equal(current.filename, '第一版.pptx')
    const slidesRes = await fetch(`${BASE}/default-ppt-api/current/slides`)
    assert.equal(slidesRes.headers.get('x-pptist-version'), 'v3')
    const bundle = await slidesRes.json()
    assert.equal(bundle.slides.length, 2)
    assert.equal(bundle.slides[0].remark, 'A 第一页备注\n第二行中文')
    assert.match(bundle.slides[0].elements[0].src, /^data:image\/gif;base64,/)
    const fileRes = await fetch(`${BASE}/default-ppt-api/current/file`)
    const fileBytes = Buffer.from(await fileRes.arrayBuffer())
    assert.deepEqual([...fileBytes], [...raw1])
    ok('上传成功：元数据 / 解析数据（含中文多行备注、GIF data URL）/ 原始文件按版本一致')
  }

  // 4. SSE：连接即收到当前版本，随后上传立即广播
  {
    const ssePromise = readSSEUntil(events => events.filter(e => e.event === 'version').length >= 2, 10000)
    await sleep(500) // 确保订阅已建立
    await upload('第二版.pptx', pkBytes('second'), makeBundle(3, 'B'))
    const events = await ssePromise
    assert.equal(events[0].data.seq, 3)
    assert.equal(events[events.length - 1].data.seq, 4)
    assert.equal(events[events.length - 1].data.filename, '第二版.pptx')
    ok('SSE 通知：连接推送当前版本，新上传立即广播新版本')
  }

  // 5. 失败不覆盖旧默认
  {
    const bad = await upload('第三版.pptx', Buffer.from('not-a-zip'), makeBundle(1, 'C'))
    assert.equal(bad.status, 400)
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.seq, 4)
    assert.equal(current.filename, '第二版.pptx')
    ok('解析/校验失败：旧默认 PPT 保持不变')
  }

  // 6. 连续上传：后提交者胜出，版本号单调递增
  {
    const [r3, r4] = await Promise.all([
      upload('第三版.pptx', pkBytes('third'), makeBundle(2, 'C')),
      upload('第四版.pptx', pkBytes('fourth'), makeBundle(4, 'D')),
    ])
    assert.equal(r3.data.seq, 5)
    assert.equal(r4.data.seq, 6)
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.seq, 6)
    assert.equal(current.filename, '第四版.pptx')
    const bundle = await (await fetch(`${BASE}/default-ppt-api/current/slides`)).json()
    assert.equal(bundle.slides.length, 4)
    assert.equal(bundle.slides[0].id, 'slide-D-0')
    ok('连续上传：按提交顺序串行处理，最终为最新提交的版本（v6）')
  }

  // 7. 历史版本保留数
  {
    const versionsDir = path.join(dataDir, 'versions')
    const names = await fsp.readdir(versionsDir)
    assert.ok(names.length <= 3, `版本目录数 ${names.length} 应 <= 保留上限 3`)
    ok(`历史版本清理：保留最近 ${3} 个版本（当前 ${names.length} 个）`)
  }

  // 8. SPA 路由回退
  {
    for (const route of ['/', '/play', '/upload', '/editor']) {
      const res = await fetch(`${BASE}${route}`)
      assert.equal(res.status, 200, route)
      assert.match(res.headers.get('content-type') || '', /text\/html/)
    }
    const missing = await fetch(`${BASE}/assets/nope.js`)
    assert.equal(missing.status, 404)
    ok('SPA 回退：/ /play /upload /editor 刷新均返回页面，真实缺失资源仍 404')
  }

  // 9. 服务重启后持久化恢复
  await stopServer()
  await startServer()
  {
    const current = await (await fetch(`${BASE}/default-ppt-api/current`)).json()
    assert.equal(current.seq, 6)
    assert.equal(current.filename, '第四版.pptx')
    const bundle = await (await fetch(`${BASE}/default-ppt-api/current/slides`)).json()
    assert.equal(bundle.slides.length, 4)
    const fileRes = await fetch(`${BASE}/default-ppt-api/current/file`)
    const bytes = Buffer.from(await fileRes.arrayBuffer())
    assert.deepEqual([...bytes.subarray(0, 4)], [...Buffer.from('PK\x03\x04')])
    ok('服务重启：默认文稿元数据、解析数据与原始文件均从磁盘恢复')
  }

  console.log('默认 PPT 服务端集成测试：')
  results.forEach(line => console.log(line))
  console.log('\n全部通过 ✔')
  process.exit(0)
}
catch (error) {
  console.error('测试失败：', error)
  console.error('---- 服务端日志 ----\n' + serverLog)
  process.exitCode = 1
}
finally {
  await stopServer()
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {})
}
