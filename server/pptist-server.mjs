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
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { attachShowFlowWs } from './showflow-ws.mjs'
import { createLedRenderService } from './led/render-service.mjs'
import { createStudioService } from './studio-service.mjs'
import { parseMarkdownManifest } from './studio-html-md-manifest.mjs'
import { createMonitorService } from './monitor-service.mjs'
import { createDefaultPptV3 } from './default-ppt-v3.mjs'
import { createMonitorMqttPublisher } from './monitor-mqtt-publisher.mjs'

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
const LED_CACHE_DIR = path.resolve(process.env.PPTIST_LED_CACHE_DIR || path.join(ROOT, 'data/led-cache'))
const LED_PORTRAIT_DIR = path.resolve(process.env.PPTIST_LED_PORTRAIT_DIR || path.join(ROOT, 'data/led-assets/portraits'))
const SHOWFLOW_STATE_FILE = path.resolve(process.env.PPTIST_SHOWFLOW_STATE_FILE || path.join(ROOT, 'data/showflow/state.json'))
const SHOWFLOW_LAST_NONEMPTY_FILE = path.join(path.dirname(SHOWFLOW_STATE_FILE), 'state.last-nonempty.json')
const PRESENTATION_LINK_CONFIG_FILE = path.resolve(process.env.PPTIST_PRESENTATION_LINK_CONFIG_FILE || path.join(ROOT, 'data/config/presentation-link.json'))
const STUDIO_DATA_DIR = path.resolve(process.env.PPTIST_STUDIO_DATA_DIR || path.join(ROOT, 'data/studio'))
const ledRenderService = createLedRenderService({ cacheDir: LED_CACHE_DIR, portraitDir: LED_PORTRAIT_DIR, publicUrl: PUBLIC_URL })
const studioService = createStudioService({ rootDir: ROOT, revealDir: REVEAL_DIR, dataDir: STUDIO_DATA_DIR })
// 双 PPT 合成监控：主屏(左 640×800) + 副屏(右 640×800) → 1280×800，联动放映时自动更新
const MONITOR_MQTT_TOPIC = process.env.PPTIST_MONITOR_MQTT_TOPIC || 'presentation/led/display'
const monitorService = createMonitorService({ cacheDir: path.join(ROOT, 'data', 'monitor') })
const monitorPublisher = createMonitorMqttPublisher({ topic: MONITOR_MQTT_TOPIC, log })
let showFlowStateWriteChain = Promise.resolve()
let getShowFlowWsStatus = () => ({ totalConnections: 0, checkedAt: Date.now(), roles: {} })

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

/** 将大上传直接落盘并解析信封边界，避免把 bundle 与原文件整体驻留内存。 */
async function receiveEnvelopeFile(req, directory, maxBytes) {
  await fsp.mkdir(directory, { recursive: true })
  const envelopeFile = path.join(directory, `incoming-${crypto.randomUUID()}.bin`)
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > maxBytes) throw new Error(`请求体过大（上限约 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
  let received = 0
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > maxBytes) callback(new Error(`请求体过大（上限约 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(req, limiter, fs.createWriteStream(envelopeFile, { flags: 'wx' }))
    if (received < 8) throw new Error('请求体为空')
    const handle = await fsp.open(envelopeFile, 'r')
    try {
      const lengths = Buffer.alloc(8)
      await handle.read(lengths, 0, 8, 0)
      const headerLen = lengths.readUInt32BE(0)
      const bundleLen = lengths.readUInt32BE(4)
      if (headerLen > 1024 * 1024 || bundleLen > 3 * 1024 * 1024 * 1024) throw new Error('请求头/解析数据超出限制')
      const fileOffset = 8 + headerLen + bundleLen
      if (fileOffset >= received) throw new Error('上传信封不完整')
      const headerBuf = Buffer.alloc(headerLen)
      await handle.read(headerBuf, 0, headerLen, 8)
      let header
      try {
        header = JSON.parse(headerBuf.toString('utf8'))
      }
      catch {
        throw new Error('请求头不是有效的 JSON')
      }
      return { envelopeFile, received, header, bundleOffset: 8 + headerLen, bundleLen, fileOffset, fileLen: received - fileOffset }
    }
    finally {
      await handle.close()
    }
  }
  catch (error) {
    await fsp.rm(envelopeFile, { force: true }).catch(() => {})
    throw error
  }
}

async function streamRange(source, target, start, length) {
  if (length <= 0) throw new Error('上传数据区段为空')
  await pipeline(fs.createReadStream(source, { start, end: start + length - 1 }), fs.createWriteStream(target, { flags: 'wx' }))
}

async function rangeContains(source, start, length, marker) {
  let tail = ''
  for await (const chunk of fs.createReadStream(source, { start, end: start + length - 1 })) {
    const text = tail + chunk.toString('utf8')
    if (text.includes(marker)) return true
    tail = text.slice(-(marker.length - 1))
  }
  return false
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
        // 校验版本目录完整性（v2: slides.json；v3: bundle.json），损坏则视为无默认文稿
        const versionDir = path.join(versionsDir, meta.version)
        const hasV2 = await fsp.stat(path.join(versionDir, 'slides.json')).then(() => true, () => false)
        const hasV3 = await fsp.stat(path.join(versionDir, 'bundle.json')).then(() => true, () => false)
        await fsp.access(path.join(versionDir, 'raw.file'))
        if (hasV2 || hasV3) current = meta
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

  /** 保留最近 N 个版本：v3 资产为懒加载，播放中的旧版本可能仍被请求（资产在全局池，不受影响） */
  async function cleanupVersions(keep = 2) {
    try {
      const names = (await fsp.readdir(versionsDir))
        .filter(n => /^v\d+$/.test(n))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))
      for (const name of names.slice(keep)) {
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

  async function processUploadEnvelope(upload) {
    const filename = String(upload.header.filename || '')
    const pageCount = Number(upload.header.pageCount)
    if (!/\.(pptx|pdf)$/i.test(filename)) throw new Error('仅支持 .pptx / .pdf 文件')
    if (upload.fileLen > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`文件超过大小上限（${MAX_UPLOAD_MB}MB）`)
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('解析结果为空，无法设为默认 PPT')
    const handle = await fsp.open(upload.envelopeFile, 'r')
    try {
      const magic = Buffer.alloc(5)
      await handle.read(magic, 0, 5, upload.fileOffset)
      if (/\.pptx$/i.test(filename) && magic.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw new Error('文件不是有效的 PPTX（ZIP）格式，可能已损坏')
      if (/\.pdf$/i.test(filename) && !magic.toString('latin1').startsWith('%PDF')) throw new Error('文件不是有效的 PDF 格式，可能已损坏')
    }
    finally {
      await handle.close()
    }
    if (!await rangeContains(upload.envelopeFile, upload.bundleOffset, upload.bundleLen, '"slides":[')) throw new Error('解析结果格式不正确')

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
      await streamRange(upload.envelopeFile, path.join(uploadTmpDir, 'raw.file'), upload.fileOffset, upload.fileLen)
      await streamRange(upload.envelopeFile, path.join(uploadTmpDir, 'slides.json'), upload.bundleOffset, upload.bundleLen)
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
    // 仅保留最近版本：历史版本按保留策略清理
    await cleanupVersions()
    broadcastVersion(meta)
    return meta
  }

  /**
   * v3 资源化发布（主屏专用）：把会话中已暂存的 bundle.json + raw.file
   * 组装为新版本并原子切换 current.json。文件经 rename 落位，服务端全程不整读 bundle。
   */
  function publishVersion({ filename, pageCount, files }) {
    const task = async () => {
      const seq = (current?.seq || 0) + 1
      const version = `v${seq}`
      const meta = { seq, version, filename, pageCount, updatedAt: new Date().toISOString() }
      const versionDir = path.join(versionsDir, version)
      const staging = path.join(tmpDir, `publish-${version}-${crypto.randomUUID()}`)
      await fsp.mkdir(staging, { recursive: true })
      try {
        await fsp.rename(files.bundlePath, path.join(staging, 'bundle.json'))
        await fsp.rename(files.rawPath, path.join(staging, 'raw.file'))
        await fsp.writeFile(path.join(staging, 'meta.json'), JSON.stringify({ ...meta, schema: 'v3' }, null, 2))
        await fsp.rm(versionDir, { recursive: true, force: true })
        await fsp.rename(staging, versionDir)
        await atomicWrite(currentFile, JSON.stringify(meta, null, 2))
      }
      catch (error) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
        throw new Error(`保存新版本失败：${error.message}`)
      }
      current = meta
      await cleanupVersions()
      broadcastVersion(meta)
      return meta
    }
    const next = uploadChain.then(task, task)
    uploadChain = next.catch(() => {})
    return next
  }

  async function handleUpload(req, res) {
    let upload = null
    try {
      // 请求流先落临时文件，内存占用不随 PPT/bundle 大小增长。
      upload = await receiveEnvelopeFile(req, tmpDir, MAX_UPLOAD_MB * 1024 * 1024 + 3 * 1024 * 1024 * 1024)
      // 串行处理：按提交顺序完成“校验→保存→原子切换→通知”
      const result = await (uploadChain = uploadChain.then(
        () => processUploadEnvelope(upload),
        () => processUploadEnvelope(upload),
      ))
      slog(`上传成功：v${result.seq} ${result.filename}（${result.pageCount} 页）`)
      sendJson(res, 200, { ok: true, ...publicMeta() })
    }
    catch (error) {
      slog('上传失败：', error.message)
      sendJson(res, 400, { ok: false, error: error.message })
    }
    finally {
      if (upload?.envelopeFile) await fsp.rm(upload.envelopeFile, { force: true }).catch(() => {})
    }
  }

  async function serveSlides(res) {
    if (!current) {
      sendJson(res, 404, { error: '暂无默认 PPT' })
      return
    }
    const versionDir = path.join(versionsDir, current.version)
    // v3 版本优先 bundle.json（轻结构，src 为资产 URL）；v2 回退 slides.json
    const hasBundle = await fsp.stat(path.join(versionDir, 'bundle.json')).then(() => true, () => false)
    const filePath = path.join(versionDir, hasBundle ? 'bundle.json' : 'slides.json')
    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat) { sendJson(res, 404, { error: '暂无默认 PPT' }); return }
    // 流式输出：大文稿的解析数据不再整份读入服务端内存
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-PPTist-Version': current.version,
    })
    fs.createReadStream(filePath).pipe(res)
  }

  async function serveFile(res) {
    if (!current) {
      sendJson(res, 404, { error: '暂无默认 PPT' })
      return
    }
    const filePath = path.join(versionsDir, current.version, 'raw.file')
    const stat = await fsp.stat(filePath).catch(() => null)
    if (!stat) { sendJson(res, 404, { error: '暂无默认 PPT' }); return }
    // 流式输出原始文件（数百 MB 的 PPTX/PDF 下载不再占用等量服务端内存）
    res.writeHead(200, {
      'Content-Type': MIME['.pptx'],
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(current.filename)}"`,
      'Cache-Control': 'no-store',
    })
    fs.createReadStream(filePath).pipe(res)
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
    versionsDir,
    ensureDirs,
    loadCurrent,
    publicMeta,
    handleUpload,
    publishVersion,
    serveEvents,
    serveSlides,
    serveFile,
    getCurrent: () => current,
  }
}

// 双槽位文稿存储：主屏（/default-ppt-api，行为不变）+ 副屏 PPTist B（/showflow-api/secondary-doc）
const mainDocStore = createDocStore({ dataDir: DATA_DIR, label: '主屏文稿' })
const secondaryDocStore = createDocStore({ dataDir: SECONDARY_DATA_DIR, label: '副屏文稿(PPTist B)' })
// 主屏 v3 资源化扩展（资产池 + 会话上传 + 版本化 bundle）；副屏不受影响
const defaultPptV3 = createDefaultPptV3({ store: mainDocStore, dataDir: DATA_DIR, maxUploadBytes: MAX_UPLOAD_MB * 1024 * 1024, log })

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
    if (pathname.startsWith('/api/studio/')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      const readJson = async () => {
        const raw = await readRawBody(req, 6 * 1024 * 1024)
        return JSON.parse(raw.toString('utf8') || '{}')
      }
      if (req.method === 'GET' && pathname === '/api/studio/render-config') {
        sendJson(res, 200, await studioService.renderConfig(url.searchParams.get('scope') === 'draft' ? 'draft' : 'active', url.searchParams.get('theme') || '')); return
      }
      if (req.method === 'GET' && ['/api/studio/html-runtime.js', '/api/studio/html-bridge.js'].includes(pathname)) {
        const script = pathname.endsWith('html-bridge.js') ? 'studio-html-bridge.js' : 'studio-html-runtime.js'
        res.setHeader('Cache-Control', 'no-store'); await serveStatic(req, res, '/' + script, __dirname); return
      }
      const htmlContentMatch = pathname.match(/^\/api\/studio\/themes\/([^/]+)\/html$/)
      if (req.method === 'GET' && htmlContentMatch) {
        const { data } = await studioService.getHtml(decodeURIComponent(htmlContentMatch[1]))
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' }); res.end(data); return
      }
      if (req.method === 'GET' && pathname === '/api/studio/slides') { sendJson(res, 200, await studioService.getSlides('draft')); return }
      if (req.method === 'GET' && pathname === '/api/studio/slides/active') { sendJson(res, 200, await studioService.getSlides('active')); return }
      if (req.method === 'GET' && pathname === '/api/studio/slides/draft/raw') {
        const { markdown } = await studioService.getSlides('draft'); res.writeHead(200, { 'Content-Type': MIME['.md'], 'Cache-Control': 'no-store' }); res.end(markdown); return
      }
      // ShowFlow 副屏清单数据源：Studio「发布」后的正式内容（从未编辑时自动播种原始样例）
      if (req.method === 'GET' && pathname === '/api/studio/slides/active/raw') {
        // ShowFlow editor compatibility: when an HTML theme is active, expose a
        // projected Markdown manifest using the teacher's original flow-* IDs
        // but the HTML's real page titles. Protocol/LCD semantics are unchanged.
        const markdown = await studioService.getShowFlowSlidesRaw('active'); res.writeHead(200, { 'Content-Type': MIME['.md'], 'Cache-Control': 'no-store' }); res.end(markdown); return
      }
      if (req.method === 'PUT' && pathname === '/api/studio/slides') { const body = await readJson(); sendJson(res, 200, { ok: true, status: await studioService.saveDraft(body.markdown) }); return }
      if (req.method === 'POST' && pathname === '/api/studio/publish') { const body = await readJson(); sendJson(res, 200, { ok: true, status: await studioService.publish(body.message) }); return }
      if (req.method === 'GET' && pathname === '/api/studio/versions') { sendJson(res, 200, { versions: await studioService.versions() }); return }
      const restoreMatch = pathname.match(/^\/api\/studio\/versions\/([^/]+)\/restore$/)
      if (req.method === 'POST' && restoreMatch) { sendJson(res, 200, { ok: true, status: await studioService.restore(decodeURIComponent(restoreMatch[1])) }); return }
      if (req.method === 'GET' && pathname === '/api/studio/assets') { sendJson(res, 200, { assets: await studioService.listAssets() }); return }
      if (req.method === 'POST' && pathname === '/api/studio/assets/upload') { const data = await readRawBody(req, 20 * 1024 * 1024); sendJson(res, 200, { ok: true, asset: await studioService.saveAsset(decodeURIComponent(req.headers['x-filename'] || ''), data) }); return }
      const assetMatch = pathname.match(/^\/api\/studio\/assets\/([^/]+)$/)
      if (req.method === 'DELETE' && assetMatch) { await studioService.deleteAsset(decodeURIComponent(assetMatch[1])); sendJson(res, 200, { ok: true }); return }
      // 四岗位头像：列表 / 上传（上传同时写一份到 LED 头像目录，LED 四屏与 reveal 页保持一致）
      if (req.method === 'GET' && pathname === '/api/studio/portraits') { sendJson(res, 200, { portraits: await studioService.listPortraits() }); return }
      const studioPortraitMatch = pathname.match(/^\/api\/studio\/portrait\/(manager|platform|twin|hardware)$/)
      if (studioPortraitMatch && req.method === 'POST') {
        const role = studioPortraitMatch[1]
        const data = await readRawBody(req, 8 * 1024 * 1024)
        const result = await studioService.savePortrait(role, decodeURIComponent(req.headers['x-filename'] || `${role}.png`), data)
        try {
          await fsp.mkdir(LED_PORTRAIT_DIR, { recursive: true })
          await atomicWrite(path.join(LED_PORTRAIT_DIR, `${role}.image`), data)
        }
        catch (ledError) { log('LED 头像同步失败（不影响 reveal 页）：', ledError.message) }
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (req.method === 'GET' && pathname === '/api/studio/system/status') { const render=ledRenderService.getStatus(); sendJson(res, 200, { studio: await studioService.status(), services: { server: 'running', webSocket: 'running', reveal: 'running', lcdRenderService: 'running' }, websocket: getShowFlowWsStatus(), lcd: { protocol: 'led-display/1.0', acknowledgement: '板端 ACK/心跳尚未配置回传 Topic', roles: ['manager','platform','twin','hardware'].map(role=>({role,online:null,currentRevision:render?.revision||null,imageUrl:render?.screens.find(item=>item.role===role)?.url||null,lastRender:render?.renderedAt||null,lastAck:null,lastHeartbeat:null,rssi:null})) } }); return }
      if (req.method === 'GET' && pathname === '/api/studio/themes') { sendJson(res, 200, { themes: await studioService.listThemes() }); return }
      if (req.method === 'GET' && pathname === '/api/studio/themes/current/download') {
        const exported = await studioService.exportTheme(url.searchParams.get('scope') || 'active')
        res.writeHead(200, { 'Content-Type': exported.contentType || 'application/zip', 'Content-Disposition': `attachment; filename="theme.${exported.contentType ? 'html' : 'zip'}"; filename*=UTF-8''${encodeURIComponent(exported.filename)}`, 'Content-Length': exported.data.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); res.end(exported.data); return
      }
      if (req.method === 'GET' && pathname === '/api/studio/themes/draft/css') { sendJson(res, 200, await studioService.getDraftThemeCss()); return }
      if (req.method === 'PUT' && pathname === '/api/studio/themes/draft/css') { const body=await readJson(); sendJson(res, 200, {ok:true,...await studioService.saveDraftThemeCss(body.css)}); return }
      if (req.method === 'POST' && pathname === '/api/studio/themes/upload') { const data = await readRawBody(req, 32 * 1024 * 1024); sendJson(res, 200, { ok: true, theme: await studioService.uploadTheme(decodeURIComponent(req.headers['x-filename'] || ''), data) }); return }
      const themeSelectMatch = pathname.match(/^\/api\/studio\/themes\/([^/]+)\/preview$/)
      if (req.method === 'POST' && themeSelectMatch) { sendJson(res, 200, { ok: true, status: await studioService.selectDraftTheme(decodeURIComponent(themeSelectMatch[1])) }); return }
      const themeFileMatch = pathname.match(/^\/api\/studio\/themes\/([^/]+)\/files\/(.+)$/)
      if (req.method === 'GET' && themeFileMatch) {
        const id = decodeURIComponent(themeFileMatch[1]); const info = await studioService.themeInfo(id)
        if (info.kind === 'html') { sendJson(res, 404, { error: 'HTML 仅在隔离副屏容器内运行；请通过下载接口获取原文件' }); return }
        const relative = decodeURIComponent(themeFileMatch[2])
        if (relative.split('/').some(part => part.startsWith('.'))) { sendJson(res, 400, { error: '非法主题资源' }); return }
        if (id === 'default') { await serveStatic(req, res, '/theme.css', REVEAL_DIR); return }
        await serveStatic(req, res, `/${themeFileMatch[2]}`, path.join(studioService.themesDir, id)); return
      }
      const themeDeleteMatch = pathname.match(/^\/api\/studio\/themes\/([^/]+)$/)
      if (req.method === 'DELETE' && themeDeleteMatch) { await studioService.deleteTheme(decodeURIComponent(themeDeleteMatch[1])); sendJson(res, 200, { ok: true }); return }
      if (req.method === 'GET' && pathname === '/api/studio/lcd/themes') { sendJson(res,200,{themes:await studioService.listLcdThemes()}); return }
      if (req.method === 'GET' && pathname === '/api/studio/lcd/themes/draft') { sendJson(res,200,await studioService.draftLcdConfig()); return }
      if (req.method === 'POST' && pathname === '/api/studio/lcd/themes/upload') { const data=await readRawBody(req,20*1024*1024); sendJson(res,200,{ok:true,theme:await studioService.uploadLcdTheme(decodeURIComponent(req.headers['x-filename']||''),data)}); return }
      if (req.method === 'PUT' && pathname === '/api/studio/lcd/themes/draft') { const body=await readJson(); sendJson(res,200,{ok:true,...await studioService.saveLcdTheme(body.id,body.config)}); return }
      const lcdSelectMatch=pathname.match(/^\/api\/studio\/lcd\/themes\/([^/]+)\/preview$/)
      if(req.method==='POST'&&lcdSelectMatch){sendJson(res,200,{ok:true,...await studioService.selectDraftLcdTheme(decodeURIComponent(lcdSelectMatch[1]))});return}
      const lcdDeleteMatch=pathname.match(/^\/api\/studio\/lcd\/themes\/([^/]+)$/)
      if(req.method==='DELETE'&&lcdDeleteMatch){await studioService.deleteLcdTheme(decodeURIComponent(lcdDeleteMatch[1]));sendJson(res,200,{ok:true});return}
      sendJson(res, 404, { error: '未知 Studio 接口' }); return
    }
    if (pathname.startsWith('/studio-assets/')) { await serveStatic(req, res, pathname.replace(/^\/studio-assets/, ''), studioService.assetsDir); return }
    // Vite 使用相对构建资源；/studio/lcd 等二级 SPA 路由会解析为 /studio/assets/*。
    if (pathname.startsWith('/studio/assets/')) { await serveStatic(req, res, pathname.replace(/^\/studio/, ''), DIST_DIR); return }
    if (pathname === '/presentation-link-api/config') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.method === 'GET') {
        try { sendJson(res, 200, { exists: true, config: JSON.parse(await fsp.readFile(PRESENTATION_LINK_CONFIG_FILE, 'utf8')) }) }
        catch (error) {
          if (error.code === 'ENOENT') sendJson(res, 200, { exists: false, config: null })
          else throw error
        }
        return
      }
      if (req.method === 'POST') {
        const chunks = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('配置数据过大'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!body.config?.mqtt || !body.config?.ws) { sendJson(res, 400, { error: '无效的放映联动配置' }); return }
        await fsp.mkdir(path.dirname(PRESENTATION_LINK_CONFIG_FILE), { recursive: true })
        await atomicWrite(PRESENTATION_LINK_CONFIG_FILE, JSON.stringify(body.config, null, 2))
        monitorPublisher.applyConfig(body.config)
        sendJson(res, 200, { ok: true }); return
      }
      sendJson(res, 405, { error: 'Method Not Allowed' }); return
    }

    if (pathname === '/showflow-api/state') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      // 读写时补齐缺失的角色源：旧版客户端会把缺 secondary 的结构写回来，
      // 导致其他窗口的副屏池永远为空
      const sanitizeState = state => {
        if (!state || !Array.isArray(state.sources)) return state
        if (!state.sources.some(s => s.role === 'main')) {
          state.sources.unshift({ id: 'main-pptist', kind: 'pptist', name: '主屏 PPTist（当前文稿）', role: 'main' })
        }
        if (!state.sources.some(s => s.role === 'secondary')) {
          state.sources.push({ id: 'secondary-reveal', kind: 'reveal-md', name: '副屏 Reveal / Markdown', role: 'secondary', mdPath: '/api/studio/slides/active/raw' })
        }
        return state
      }
      if (req.method === 'GET') {
        try {
          const state = sanitizeState(JSON.parse(await fsp.readFile(SHOWFLOW_STATE_FILE, 'utf8')))
          sendJson(res, 200, { exists: true, state: { ...state, serverRevision: Number(state.serverRevision || 0) } })
        }
        catch (error) {
          if (error.code === 'ENOENT') sendJson(res, 200, { exists: false, state: null })
          else throw error
        }
        return
      }
      if (req.method === 'POST') {
        const chunks = []; let size = 0
        for await (const chunk of req) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error('ShowFlow 方案数据不能超过 5MB'); chunks.push(chunk) }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (!body.state || !Array.isArray(body.state.sources) || !Array.isArray(body.state.flows) || !body.state.flows.length ||
            body.state.flows.some(flow => !flow || typeof flow.id !== 'string' || !Array.isArray(flow.steps)) ||
            !body.state.flows.some(flow => flow.id === body.state.activeFlowId)) {
          sendJson(res, 400, { error: '无效的 ShowFlow 方案数据' }); return
        }
        const state = sanitizeState(body.state)
        const totalSteps = value => Array.isArray(value?.flows)
          ? value.flows.reduce((sum, flow) => sum + (Array.isArray(flow?.steps) ? flow.steps.length : 0), 0)
          : 0
        // 即使多个页面同时保存，也按服务端接收顺序逐个落盘；非空版本另存恢复副本。
        showFlowStateWriteChain = showFlowStateWriteChain.catch(() => {}).then(async () => {
          await fsp.mkdir(path.dirname(SHOWFLOW_STATE_FILE), { recursive: true })
          const previous = await fsp.readFile(SHOWFLOW_STATE_FILE, 'utf8').then(JSON.parse).catch(() => null)
          const currentRevision = Number(previous?.serverRevision || 0)
          if (Number(body.baseRevision || 0) !== currentRevision) {
            const conflict = new Error('方案已被其他电脑更新')
            conflict.code = 'SHOWFLOW_CONFLICT'
            throw conflict
          }
          state.serverRevision = currentRevision + 1
          if (totalSteps(previous) > 0) await atomicWrite(SHOWFLOW_LAST_NONEMPTY_FILE, JSON.stringify(previous, null, 2))
          await atomicWrite(SHOWFLOW_STATE_FILE, JSON.stringify(state, null, 2))
          if (totalSteps(state) > 0) await atomicWrite(SHOWFLOW_LAST_NONEMPTY_FILE, JSON.stringify(state, null, 2))
        })
        try {
          await showFlowStateWriteChain
        }
        catch (error) {
          if (error.code === 'SHOWFLOW_CONFLICT') { sendJson(res, 409, { ok: false, error: error.message }); return }
          throw error
        }
        sendJson(res, 200, { ok: true, revision: state.serverRevision }); return
      }
      sendJson(res, 405, { error: 'Method Not Allowed' }); return
    }
    if (req.method === 'POST' && pathname === '/led-render-api/render') {
      res.setHeader('Access-Control-Allow-Origin', '*')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (!body.state || typeof body.state !== 'object') {
        sendJson(res, 400, { error: 'state 必须是 LcdSceneState' })
        return
      }
      const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`
      sendJson(res, 200, await ledRenderService.render(body.state, origin, body.theme || await studioService.activeLcdConfig()))
      return
    }
    const portraitMatch = pathname.match(/^\/led-render-api\/portrait\/(manager|platform|twin|hardware)$/)
    if (portraitMatch && req.method === 'GET') {
      // 读取当前 LED 头像（文件无扩展名，按魔数识别类型；未设置时 404）
      const role = portraitMatch[1]
      const file = path.join(LED_PORTRAIT_DIR, `${role}.image`)
      const data = await fsp.readFile(file).catch(() => null)
      if (!data) { sendJson(res, 404, { error: '该岗位尚未设置 LCD 头像' }); return }
      const head = data.subarray(0, 12).toString('latin1')
      const type = head.startsWith('GIF89a') || head.startsWith('GIF87a') ? 'image/gif'
        : head.startsWith('\x89PNG') ? 'image/png'
        : head.startsWith('\xFF\xD8\xFF') ? 'image/jpeg'
        : head.startsWith('RIFF') && head.includes('WEBP') ? 'image/webp'
        : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
      res.end(data)
      return
    }
    // 双 PPT 合成监控：半区上传 + 最新合成图 HTTP 下载
    if (pathname.startsWith('/monitor-api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      const monitorRoleMatch = pathname.match(/^\/monitor-api\/screen\/(main|secondary)$/)
      if (monitorRoleMatch && req.method === 'POST') {
        const body = JSON.parse((await readRawBody(req, 8 * 1024 * 1024)).toString('utf8') || '{}')
        const snapshot = await monitorService.applyHalf(monitorRoleMatch[1], body)
        const origin = PUBLIC_URL || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`
        const imageUrl = `${origin}/monitor-api/display/${snapshot.revision}.jpg`
        monitorPublisher.publish({
          protocol: 'led-display/1.0', type: 'display', msg_id: `monitor-${snapshot.revision}`,
          revision: snapshot.revision, role: 'dual',
          image: { url: imageUrl, format: 'jpeg', width: 1280, height: 800, sha256: snapshot.sha256 },
          mainPage: snapshot.mainPage || undefined, secondaryPage: snapshot.secondaryPage || undefined,
        })
        sendJson(res, 200, {
          ok: true, revision: snapshot.revision, url: `/monitor-api/display/${snapshot.revision}.jpg`,
          mqttTopic: MONITOR_MQTT_TOPIC, width: 1280, height: 800,
          sha256: snapshot.sha256, mainPage: snapshot.mainPage, secondaryPage: snapshot.secondaryPage,
        })
        return
      }
      const monitorImageMatch = pathname.match(/^\/monitor-api\/display\/(\d+)\.jpg$/)
      if (monitorImageMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const target = await monitorService.displayJpeg(Number(monitorImageMatch[1]))
        if (!target) { sendJson(res, 404, { error: '该 revision 已过期或不存在' }); return }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': target.length, 'Cache-Control': 'public, max-age=86400, immutable', 'ETag': `"monitor-${monitorImageMatch[1]}"` })
        if (req.method === 'HEAD') res.end(); else res.end(target)
        return
      }
      if (pathname === '/monitor-api/display' && (req.method === 'GET' || req.method === 'HEAD')) {
        const jpeg = await monitorService.displayJpeg()
        if (!jpeg) { sendJson(res, 404, { error: '尚无合成画面（等待联动放映）' }); return }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store' })
        res.end(jpeg)
        return
      }
      if (pathname === '/monitor-api/status' && req.method === 'GET') { sendJson(res, 200, { ...monitorService.status(), mqtt: monitorPublisher.status() }); return }
      sendJson(res, 404, { error: '未知接口' })
      return
    }
    if (portraitMatch && req.method === 'POST') {
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new Error('头像不能超过 8MB')
        chunks.push(chunk)
      }
      const data = Buffer.concat(chunks)
      if (!data.length) { sendJson(res, 400, { error: '头像文件为空' }); return }
      await fsp.mkdir(LED_PORTRAIT_DIR, { recursive: true })
      await atomicWrite(path.join(LED_PORTRAIT_DIR, `${portraitMatch[1]}.image`), data)
      sendJson(res, 200, { ok: true, role: portraitMatch[1] })
      return
    }
    if (pathname.startsWith('/led/')) {
      await serveStatic(req, res, pathname.replace(/^\/led/, '') || '/', LED_CACHE_DIR)
      return
    }
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
      // v3 会话上传 / 资产池 / 版本化 bundle（主屏专用；命中即处理完毕）
      if (await defaultPptV3.handle(req, res, url)) return
      if (req.method === 'GET' && pathname === '/default-ppt-api/config') {
        sendJson(res, 200, {
          publicBaseUrl: PUBLIC_URL || null,
          maxUploadMB: MAX_UPLOAD_MB,
          acceptTypes: ['.pptx', '.pdf'],
          // 上传信封协议版本：前端据此检测与服务端版本是否一致（旧版服务端无此字段）
          uploadEnvelope: 2,
          // v3 资源化上传（会话式 + 资产池）能力标记
          uploadV3: 1,
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
      if (req.method === 'GET' && (pathname === '/reveal/' || pathname === '/reveal/index.html') && !url.searchParams.has('md') && url.searchParams.get('content') !== 'markdown') {
        const config = await studioService.renderConfig(url.searchParams.get('studio') === 'draft' ? 'draft' : 'active', url.searchParams.get('studioTheme') || '')
        if (config.kind === 'html') {
          const shell = await fsp.readFile(path.join(__dirname, 'studio-html-runtime.html'))
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(shell); return
        }
      }

      // Display-only/native fallback and Studio previews must NOT register another
      // secondary role. Keep the teacher's original showflow.js byte-for-byte;
      // omit its script tag only for these non-participating view containers.
      if (req.method === 'GET' && (pathname === '/reveal/' || pathname === '/reveal/index.html') &&
          (url.searchParams.has('displayOnly') || url.searchParams.get('studio') === 'draft' || url.searchParams.has('thumb'))) {
        let html = await fsp.readFile(path.join(REVEAL_DIR, 'index.html'), 'utf8')
        html = html.replace(/<script\b[^>]*src=["'](?:\.\/)?showflow\.js[^"']*["'][^>]*>[\s\S]*?<\/script\s*>/gi, '')
        if (url.searchParams.has('displayOnly')) {
          const token = url.searchParams.get('sfToken') || ''
          if (!/^[0-9a-f]{32}$/.test(token)) { sendJson(res, 400, { error: '显示帧 token 无效' }); return }
          const { markdown } = await studioService.getSlides(url.searchParams.get('studio') === 'draft' ? 'draft' : 'active')
          const config = JSON.stringify({ token, adapter: 'native', parentOrigin: 'self', manifest: parseMarkdownManifest(markdown) }).replace(/</g, '\\u003c')
          html = html.replace(/<\/body>/i, `<script id="showflow-bridge-config" type="application/json">${config}</script><script src="/api/studio/html-bridge.js"></script></body>`)
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(html); return
      }

      if (pathname === '/reveal/slides.md') {
        const { markdown } = await studioService.getSlides('active')
        res.writeHead(200, { 'Content-Type': MIME['.md'], 'Cache-Control': 'no-store' }); res.end(markdown); return
      }
      // 四岗位头像按角色回退解析：引用固定为 {role}.png，实际文件扩展名可不同
      // （Studio 上传 GIF 后引用无需改动，浏览器 img 原生播放动图）
      const revealPortraitMatch = pathname.match(/^\/reveal\/portraits\/(manager|platform|twin|hardware)\.png$/)
      if (revealPortraitMatch && req.method === 'GET') {
        const role = revealPortraitMatch[1]
        const dir = path.join(REVEAL_DIR, 'portraits')
        const names = await fsp.readdir(dir).catch(() => [])
        const hit = names.find(n => n.startsWith(role + '.') && ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(path.extname(n).toLowerCase()))
        await serveStatic(req, res, '/' + (hit || role + '.png'), dir)
        return
      }
      if (pathname === '/reveal/theme.css') {
        const meta = await studioService.status()
        if (meta.activeRevealTheme && meta.activeRevealTheme !== 'default' && (await studioService.themeInfo(meta.activeRevealTheme)).kind === 'css') { await serveStatic(req, res, '/theme.css', path.join(studioService.themesDir, meta.activeRevealTheme)); return }
      }
      const themeAssetExt = path.extname(pathname).toLowerCase()
      if (['.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2'].includes(themeAssetExt)) {
        const meta = await studioService.status()
        if (meta.activeRevealTheme && meta.activeRevealTheme !== 'default') {
          const themeDir = path.join(studioService.themesDir, meta.activeRevealTheme)
          const relative = pathname.replace(/^\/reveal/, '') || '/'
          const candidate = path.resolve(themeDir, `.${decodeURIComponent(relative)}`)
          if (candidate.startsWith(themeDir + path.sep) && (await fsp.stat(candidate).catch(() => null))?.isFile()) { await serveStatic(req, res, relative, themeDir); return }
        }
      }
      await serveStatic(req, res, pathname.replace(/^\/reveal/, '') || '/', REVEAL_DIR)
      return
    }

    // Studio 页面主题兼容入口：不依赖重新构建 dist。
    // 仅替换 /studio/theme 的管理 UI；其他 Studio 页面仍由原 SPA 提供。
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/studio/theme') {
      const file = path.join(__dirname, 'studio-theme-admin.html')
      const data = await fsp.readFile(file)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      if (req.method === 'GET') res.end(data); else res.end()
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

await Promise.all([mainDocStore.ensureDirs(), secondaryDocStore.ensureDirs(), studioService.init(), monitorService.init()])
// ensureDirs 会清空 tmp/（含 v3 会话目录），v3 初始化必须在其后重建
await defaultPptV3.init()
try { monitorPublisher.applyConfig(JSON.parse(await fsp.readFile(PRESENTATION_LINK_CONFIG_FILE, 'utf8'))) } catch { /* 尚未配置 MQTT */ }
await Promise.all([mainDocStore.loadCurrent(), secondaryDocStore.loadCurrent()])
const showFlowWs = attachShowFlowWs(server, log)
getShowFlowWsStatus = showFlowWs.getStatus
server.listen(PORT, '0.0.0.0', () => {
  log(`服务已启动：http://0.0.0.0:${PORT}（播放页 /play，上传页 /upload，编辑器 /editor，联动编排 /showflow，副屏 Reveal /reveal，副屏 PPTist /secondary）`)
  log(`ShowFlow WebSocket: ws://0.0.0.0:${PORT}/showflow`)
  const mainCurrent = mainDocStore.getCurrent()
  const secondaryCurrent = secondaryDocStore.getCurrent()
  log(`主屏文稿目录：${DATA_DIR}（${mainCurrent ? `v${mainCurrent.seq} ${mainCurrent.filename}，${mainCurrent.pageCount} 页` : '暂无'}）`)
  log(`副屏文稿目录：${SECONDARY_DATA_DIR}（${secondaryCurrent ? `v${secondaryCurrent.seq} ${secondaryCurrent.filename}，${secondaryCurrent.pageCount} 页` : '暂无'}）`)
})
