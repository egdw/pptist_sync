/* eslint-env node */
/**
 * PPTist 轻量服务端（零第三方依赖，Node >= 18；WebSocket 由 ws 提供）
 *
 * 职责：
 * 1. 托管前端构建产物（dist/），/、/play、/upload、/editor、/showflow、/secondary 等 SPA 路由刷新不 404；
 * 2. 「默认 PPT」文稿存储（双槽位，互相独立）：
 *    - 主屏文稿：/default-ppt-api/*（原接口，编辑器与 /play 播放页使用，行为不变）
 *    - 副屏文稿（PPTist B）：/showflow-api/secondary-doc/*（双 PPTist 模式独立文档）
 *    两槽位均为「版本目录 + current.json 原子切换 + SSE 通知」结构，上传原子切换、
 *    历史版本自动清理、SSE 断线重连自动对账；
 * 3. 副屏 Reveal / Markdown 演示页静态托管（/reveal/*）；
 * 4. SSE 更新通知：新版本发布后立即通知所有已连接的播放端；
 * 5. 代理 /api/* 到 PPTist 官方接口（AIPPT 等），保持编辑器原有能力可用；
 * 6. ShowFlow WebSocket（/showflow，见 showflow-ws.mjs）。
 *
 * 环境变量：
 *   PPTIST_PORT          监听端口（默认 8686，绑定 0.0.0.0 供局域网访问）
 *   PPTIST_DATA_DIR      主屏文稿持久化目录（默认 <项目根>/data/default-ppt）
 *   PPTIST_SECONDARY_DATA_DIR 副屏文稿持久化目录（默认 <项目根>/data/secondary-ppt）
 *   PPTIST_DIST_DIR      前端构建产物目录（默认 <项目根>/dist）
 *   PPTIST_REVEAL_DIR    副屏 Reveal 静态页目录
 *   PPTIST_PUBLIC_URL    对外访问基地址（如 http://192.168.1.10:8686），用于播放页展示上传地址；缺省用请求的 origin
 *   PPTIST_MAX_UPLOAD_MB 允许的 .pptx / .pdf 大小上限（默认 1024，即 1GB；解析在浏览器端完成，超大文件需要上传端有足够内存）
 *   PPTIST_REMOTE_API    /api/* 代理目标（默认 https://server.pptist.cn，置空禁用）
 *
 * 数据目录结构（每个槽位相同）：
 *   <DATA_DIR>/current.json                     当前版本元数据（临时文件+rename 原子写入）
 *   <DATA_DIR>/versions/v<seq>/raw.file         原始文件（.pptx / .pdf）
 *   <DATA_DIR>/versions/v<seq>/slides.json      解析后的文稿数据（图片为 base64 data URL，含 GIF）
 *   <DATA_DIR>/versions/v<seq>/meta.json        该版本元数据
 *   仅保留当前版本：新版本上传成功后，其余版本目录立即清理。
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { attachShowFlowWs } from './showflow-ws.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = Number(process.env.PPTIST_PORT || 8686)
const DATA_DIR = path.resolve(process.env.PPTIST_DATA_DIR || path.join(ROOT, 'data/default-ppt'))
const SECONDARY_DATA_DIR = path.resolve(process.env.PPTIST_SECONDARY_DATA_DIR || path.join(ROOT, 'data/secondary-ppt'))
const DIST_DIR = path.resolve(process.env.PPTIST_DIST_DIR || path.join(ROOT, 'dist'))
const REVEAL_DIR = path.resolve(process.env.PPTIST_REVEAL_DIR || path.join(ROOT, 'reveal-example', 'reveal-markdown-evidence-screen-v4.2'))
const PUBLIC_URL = (process.env.PPTIST_PUBLIC_URL || '').replace(/\/+$/, '')
const MAX_UPLOAD_MB = Math.max(1, Number(process.env.PPTIST_MAX_UPLOAD_MB || 1024))
const REMOTE_API = process.env.PPTIST_REMOTE_API !== undefined ? process.env.PPTIST_REMOTE_API : 'https://server.pptist.cn'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

function log(...args) {
  console.log(`[pptist-server] ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`, ...args)
}

/** 原子写入（临时文件 + rename） */
async function atomicWrite(file, data) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, file)
}

/**
 * 校验上传内容（二进制信封 v2：[4 字节头长度][4 字节 bundle 长度][头部 JSON{filename,pageCount}][bundle 字节][原始文件字节]）。
 * bundle（解析后的文稿 JSON）不再整体 JSON.parse——按字节范围原样落盘，
 * 服务端只做轻量结构检查，内存占用与校验开销不随文稿大小膨胀。
 */
function validateUpload({ filename, file, bundleBuf, pageCount }) {
  filename = String(filename || '')
  if (!/\.(pptx|pdf)$/i.test(filename)) throw new Error('仅支持 .pptx / .pdf 文件')
  if (!Buffer.isBuffer(file) || file.length === 0) throw new Error('缺少文件内容')
  if (file.length > MAX_UPLOAD_MB * 1024 * 1024) {
    throw new Error(`文件超过大小上限（${MAX_UPLOAD_MB}MB）`)
  }
  const magic4 = file.subarray(0, 4).toString('latin1')
  if (/\.pptx$/i.test(filename)) {
    if (magic4 !== 'PK\x03\x04') throw new Error('文件不是有效的 PPTX（ZIP）格式，可能已损坏')
  }
  else if (!file.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
    throw new Error('文件不是有效的 PDF 格式，可能已损坏')
  }
  if (!Buffer.isBuffer(bundleBuf) || bundleBuf.length < 10) throw new Error('解析结果为空，无法设为默认 PPT')
  if (bundleBuf.indexOf('"slides":[') === -1) throw new Error('解析结果格式不正确')
  const pages = Number(pageCount)
  if (!Number.isInteger(pages) || pages < 1) throw new Error('解析结果为空，无法设为默认 PPT')
  return { filename, file, bundleBuf, pageCount: pages }
}

/** 拆解二进制信封 v2 请求体为 { filename, pageCount, bundleBuf, file } */
function parseEnvelope(body) {
  if (body.length < 8) throw new Error('请求体为空')
  const headerLen = body.readUInt32BE(0)
  const bundleLen = body.readUInt32BE(4)
  if (headerLen > 1024 * 1024 || bundleLen > 3 * 1024 * 1024 * 1024) throw new Error('请求头/解析数据超出限制')
  let header
  try {
    header = JSON.parse(body.subarray(8, 8 + headerLen).toString('utf8'))
  }
  catch {
    throw new Error('请求头不是有效的 JSON')
  }
  header.bundleBuf = body.subarray(8 + headerLen, 8 + headerLen + bundleLen)
  header.file = body.subarray(8 + headerLen + bundleLen)
  return header
}

/**
 * 文稿存储槽位（主屏 / 副屏各一个实例，状态互相独立）。
 * 上传按提交顺序串行处理；各播放端已将文稿载入内存，历史版本清理不影响播放。
 */
function createDocStore({ dataDir, label }) {
  const versionsDir = path.join(dataDir, 'versions')
  const tmpDir = path.join(dataDir, 'tmp')
  const currentFile = path.join(dataDir, 'current.json')

  /** 当前版本元数据：{ seq, version, filename, pageCount, updatedAt } 或 null */
  let current = null
  const sseClients = new Set()
  // 上传串行队列：按提交顺序处理，后提交者完成后覆盖先提交者，避免旧任务晚到覆盖新文稿
  let uploadChain = Promise.resolve()

  const slog = (...args) => log(`[${label}]`, ...args)

  async function ensureDirs() {
    await fsp.mkdir(versionsDir, { recursive: true })
    await fsp.mkdir(tmpDir, { recursive: true })
    // 清理上次进程遗留的临时目录（此时不存在“正在加载的旧版资源”）
    const stale = await fsp.readdir(tmpDir).catch(() => [])
    for (const name of stale) {
      await fsp.rm(path.join(tmpDir, name), { recursive: true, force: true }).catch(() => {})
    }
  }

  async function loadCurrent() {
    try {
      const raw = await fsp.readFile(currentFile, 'utf8')
      const meta = JSON.parse(raw)
      if (meta && meta.version && meta.seq > 0) {
        // 校验版本目录完整性，损坏则视为无默认文稿
        await fsp.access(path.join(versionsDir, meta.version, 'slides.json'))
        await fsp.access(path.join(versionsDir, meta.version, 'raw.file'))
        current = meta
      }
    }
    catch {
      current = null
    }
  }

  function publicMeta() {
    if (!current) return { exists: false }
    const { seq, version, filename, pageCount, updatedAt } = current
    return { exists: true, seq, version, filename, pageCount, updatedAt }
  }

  /** 仅保留当前版本：其余版本目录全部清理（播放端已将文稿载入内存，删除不影响播放） */
  async function cleanupVersions() {
    try {
      const names = await fsp.readdir(versionsDir)
      for (const name of names) {
        if (name === current?.version) continue
        await fsp.rm(path.join(versionsDir, name), { recursive: true, force: true }).catch(() => {})
      }
    }
    catch (error) {
      slog('清理历史版本失败：', error.message)
    }
  }

  function broadcastVersion(meta) {
    const payload = `event: version\ndata: ${JSON.stringify(publicMeta())}\n\n`
    for (const res of sseClients) {
      try {
        res.write(payload)
      }
      catch {
        sseClients.delete(res)
      }
    }
    slog(`已广播新版本 v${meta.seq}（${meta.filename}，${meta.pageCount} 页）给 ${sseClients.size} 个播放端`)
  }

  function serveEvents(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    })
    res.write(':connected\n\n')
    // 连接建立即推送当前版本：播放端据此对账，补上断线期间错过的更新
    res.write(`event: version\ndata: ${JSON.stringify(publicMeta())}\n\n`)
    sseClients.add(res)
    slog('SSE 连接建立，当前客户端数', sseClients.size)
    res.on('close', () => {
      sseClients.delete(res)
    })
  }

  async function processUpload(body) {
    const { filename, file, bundleBuf, pageCount } = validateUpload(body)

    const seq = (current?.seq || 0) + 1
    const version = `v${seq}`
    const meta = {
      seq,
      version,
      filename,
      pageCount,
      updatedAt: new Date().toISOString(),
    }

    // 先写入独立版本目录，再原子切换 current.json；任一步失败不影响旧默认
    const versionDir = path.join(versionsDir, version)
    const uploadTmpDir = path.join(tmpDir, `${version}-${crypto.randomUUID()}`)
    await fsp.mkdir(uploadTmpDir, { recursive: true })
    try {
      await fsp.writeFile(path.join(uploadTmpDir, 'raw.file'), file)
      await fsp.writeFile(path.join(uploadTmpDir, 'slides.json'), bundleBuf)
      await fsp.writeFile(path.join(uploadTmpDir, 'meta.json'), JSON.stringify(meta, null, 2))
      await fsp.rm(versionDir, { recursive: true, force: true })
      await fsp.rename(uploadTmpDir, versionDir)
      await atomicWrite(currentFile, JSON.stringify(meta, null, 2))
    }
    catch (error) {
      await fsp.rm(uploadTmpDir, { recursive: true, force: true }).catch(() => {})
      throw new Error(`保存新版本失败：${error.message}`)
    }

    current = meta
    // 仅保留当前版本：历史版本立即清理（各播放端已将文稿载入内存，不受影响）
    await cleanupVersions()
    broadcastVersion(meta)
    return meta
  }

  async function handleUpload(req, res) {
    try {
      // 请求体上限 = 文件上限 + 3GB（bundle 余量）
      const body = await readRawBody(req, MAX_UPLOAD_MB * 1024 * 1024 + 3 * 1024 * 1024 * 1024)
      const header = parseEnvelope(body)
      // 串行处理：按提交顺序完成“校验→保存→原子切换→通知”
      const result = await (uploadChain = uploadChain.then(
        () => processUpload(header),
        () => processUpload(header),
      ))
      slog(`上传成功：v${result.seq} ${result.filename}（${result.pageCount} 页）`)
      sendJson(res, 200, { ok: true, ...publicMeta() })
    }
    catch (error) {
      slog('上传失败：', error.message)
      sendJson(res, 400, { ok: false, error: error.message })
    }
  }

  async function serveSlides(res) {
    if (!current) {
      sendJson(res, 404, { error: '暂无默认 PPT' })
      return
    }
    const bundle = await fsp.readFile(path.join(versionsDir, current.version, 'slides.json'), 'utf8')
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-PPTist-Version': current.version,
    })
    res.end(bundle)
  }

  async function serveFile(res) {
    if (!current) {
      sendJson(res, 404, { error: '暂无默认 PPT' })
      return
    }
    const raw = await fsp.readFile(path.join(versionsDir, current.version, 'raw.file'))
    res.writeHead(200, {
      'Content-Type': MIME['.pptx'],
      'Content-Length': raw.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(current.filename)}"`,
      'Cache-Control': 'no-store',
    })
    res.end(raw)
  }

  // 心跳：防止空闲 SSE 连接被代理/防火墙断开
  setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(':ping\n\n')
      }
      catch {
        sseClients.delete(res)
      }
    }
  }, 25000).unref()

  return {
    label,
    ensureDirs,
    loadCurrent,
    publicMeta,
    handleUpload,
    serveEvents,
    serveSlides,
    serveFile,
    getCurrent: () => current,
  }
}

// 双槽位文稿存储：主屏（/default-ppt-api，行为不变）+ 副屏 PPTist B（/showflow-api/secondary-doc）
const mainDocStore = createDocStore({ dataDir: DATA_DIR, label: '主屏文稿' })
const secondaryDocStore = createDocStore({ dataDir: SECONDARY_DATA_DIR, label: '副屏文稿(PPTist B)' })

/** 读取原始请求体：优先按 Content-Length 一次性预分配（大文件上传避免双倍内存），超限立即断开 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10) || 0
    if (declared > maxBytes) {
      reject(new Error(`请求体过大（上限约 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
      req.destroy()
      return
    }
    const buffer = declared > 0 ? Buffer.allocUnsafe(declared) : Buffer.alloc(0)
    const chunks = buffer.length > 0 ? null : []
    let size = 0
    let offset = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error(`请求体过大（上限约 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      if (buffer.length > 0) {
        chunk.copy(buffer, offset)
        offset += chunk.length
      }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (buffer.length > 0) resolve(buffer.subarray(0, offset))
      else resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

async function serveStatic(req, res, pathname, baseDir = DIST_DIR) {
  let filePath = path.normalize(path.join(baseDir, decodeURIComponent(pathname)))
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  let stat = await fsp.stat(filePath).catch(() => null)
  if (stat?.isDirectory()) {
    filePath = path.join(filePath, 'index.html')
    stat = await fsp.stat(filePath).catch(() => null)
  }
  if (!stat) {
    // SPA 路由回退：无扩展名的路径一律回退到 index.html（/play、/upload、/editor 刷新不 404）
    if (!path.extname(pathname)) {
      filePath = path.join(baseDir, 'index.html')
      stat = await fsp.stat(filePath).catch(() => null)
    }
    if (!stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
  }
  const ext = path.extname(filePath).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // HTML 壳禁止缓存：否则发新版后浏览器仍引用旧 hash 资源，表现为"改了代码不生效"
    ...(ext === '.html' ? { 'Cache-Control': 'no-cache' } : {}),
  })
  fs.createReadStream(filePath).pipe(res)
}

/** 代理 /api/* 到 PPTist 官方接口（AIPPT、图片搜索等），保持编辑器联网能力 */
function proxyRemoteApi(req, res, pathname) {
  const target = new URL(REMOTE_API)
  const options = {
    hostname: target.hostname,
    port: target.port || 443,
    path: pathname.replace(/^\/api/, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''),
    method: req.method,
    headers: { ...req.headers, host: target.hostname },
  }
  const upstream = https.request(options, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  upstream.on('error', error => {
    log('代理 /api 失败：', error.message)
    if (!res.headersSent) sendJson(res, 502, { error: `代理请求失败：${error.message}` })
    else res.end()
  })
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  try {
    // CORS：默认同源部署；如需跨域部署可用环境变量放开（这里对 API 统一允许，静态资源同源）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    if (pathname.startsWith('/default-ppt-api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.method === 'GET' && pathname === '/default-ppt-api/config') {
        sendJson(res, 200, {
          publicBaseUrl: PUBLIC_URL || null,
          maxUploadMB: MAX_UPLOAD_MB,
          acceptTypes: ['.pptx', '.pdf'],
          // 上传信封协议版本：前端据此检测与服务端版本是否一致（旧版服务端无此字段）
          uploadEnvelope: 2,
        })
        return
      }
      if (req.method === 'GET' && pathname === '/default-ppt-api/current') {
        sendJson(res, 200, mainDocStore.publicMeta())
        return
      }
      if (req.method === 'GET' && pathname === '/default-ppt-api/current/slides') {
        await mainDocStore.serveSlides(res)
        return
      }
      if (req.method === 'GET' && pathname === '/default-ppt-api/current/file') {
        await mainDocStore.serveFile(res)
        return
      }
      if (req.method === 'GET' && pathname === '/default-ppt-api/events') {
        mainDocStore.serveEvents(res)
        return
      }
      if (req.method === 'POST' && pathname === '/default-ppt-api/upload') {
        await mainDocStore.handleUpload(req, res)
        return
      }
      sendJson(res, 404, { error: '未知接口' })
      return
    }

    // 副屏文稿（PPTist B）：接口结构与主屏完全一致，存储互相独立
    if (pathname.startsWith('/showflow-api/secondary-doc/')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.method === 'GET' && pathname === '/showflow-api/secondary-doc/current') {
        sendJson(res, 200, secondaryDocStore.publicMeta())
        return
      }
      if (req.method === 'GET' && pathname === '/showflow-api/secondary-doc/current/slides') {
        await secondaryDocStore.serveSlides(res)
        return
      }
      if (req.method === 'GET' && pathname === '/showflow-api/secondary-doc/current/file') {
        await secondaryDocStore.serveFile(res)
        return
      }
      if (req.method === 'GET' && pathname === '/showflow-api/secondary-doc/events') {
        secondaryDocStore.serveEvents(res)
        return
      }
      if (req.method === 'POST' && pathname === '/showflow-api/secondary-doc/upload') {
        await secondaryDocStore.handleUpload(req, res)
        return
      }
      sendJson(res, 404, { error: '未知接口' })
      return
    }

    if (pathname.startsWith('/api/') && REMOTE_API) {
      proxyRemoteApi(req, res, pathname)
      return
    }

    // 副屏 Reveal / Markdown 演示页（静态托管）。
    // /reveal 必须正向重定向到 /reveal/：目录下脚本均为相对路径引用（vendor/...），
    // 无尾斜杠时会被解析到站点根 /vendor/... 404，整页瘫痪
    if (pathname === '/reveal') {
      res.writeHead(301, { Location: '/reveal/' })
      res.end()
      return
    }
    if (pathname.startsWith('/reveal/')) {
      await serveStatic(req, res, pathname.replace(/^\/reveal/, '') || '/', REVEAL_DIR)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method Not Allowed' })
      return
    }

    // SPA 子路由尾斜杠重定向：构建产物资源为相对路径（./assets/...），
    // /secondary/ 会被浏览器解析为 /secondary/assets/... 导致 404、应用无法挂载
    if (pathname.length > 1 && pathname.endsWith('/') && !path.extname(pathname) && !pathname.startsWith('/reveal')) {
      res.writeHead(301, { Location: pathname.replace(/\/+$/, '') || '/' })
      res.end()
      return
    }

    await serveStatic(req, res, pathname)
  }
  catch (error) {
    log('请求处理异常：', error.message)
    if (!res.headersSent) sendJson(res, 500, { error: error.message })
    else res.end()
  }
})

await Promise.all([mainDocStore.ensureDirs(), secondaryDocStore.ensureDirs()])
await Promise.all([mainDocStore.loadCurrent(), secondaryDocStore.loadCurrent()])
attachShowFlowWs(server, log)
server.listen(PORT, '0.0.0.0', () => {
  log(`服务已启动：http://0.0.0.0:${PORT}（播放页 /play，上传页 /upload，编辑器 /editor，联动编排 /showflow，副屏 Reveal /reveal，副屏 PPTist /secondary）`)
  log(`ShowFlow WebSocket: ws://0.0.0.0:${PORT}/showflow`)
  const mainCurrent = mainDocStore.getCurrent()
  const secondaryCurrent = secondaryDocStore.getCurrent()
  log(`主屏文稿目录：${DATA_DIR}（${mainCurrent ? `v${mainCurrent.seq} ${mainCurrent.filename}，${mainCurrent.pageCount} 页` : '暂无'}）`)
  log(`副屏文稿目录：${SECONDARY_DATA_DIR}（${secondaryCurrent ? `v${secondaryCurrent.seq} ${secondaryCurrent.filename}，${secondaryCurrent.pageCount} 页` : '暂无'}）`)
})
