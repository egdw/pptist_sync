/** Additive, zero-dependency HTML storage. Original PPT upload/data paths are not changed. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'html-web')

const VERSION_RE = /^h-\d{13}-[a-f0-9]{12}$/
const MAX_JSON = 8192
const fail = (status, message) => Object.assign(new Error(message), { status })

export async function createHtmlPresentations({ dataDir, publicUrl = '', getPpt, log = console.log }) {
  const dir = path.resolve(process.env.PPTIST_HTML_DATA_DIR || path.join(dataDir, 'html-presentations'))
  const versionsDir = path.join(dir, 'versions')
  const stateFile = path.join(dir, 'state.json')
  const maxMB = Math.min(256, Math.max(1, Number(process.env.PPTIST_HTML_MAX_MB) || 32))
  const uploadKey = process.env.PPTIST_HTML_UPLOAD_KEY || ''
  const allowedOrigins = (process.env.PPTIST_HTML_ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean)
  const clients = new Set()
  let queue = Promise.resolve()
  let state = { revision: 0, mode: 'ppt', activeVersion: null }
  await fsp.mkdir(versionsDir, { recursive: true })
  try {
    const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
    if (Number.isInteger(saved.revision) && ['ppt', 'html'].includes(saved.mode)) {
      if (saved.activeVersion && !VERSION_RE.test(saved.activeVersion)) throw new Error('bad version')
      if (saved.mode === 'html') await fsp.access(path.join(versionsDir, saved.activeVersion, 'index.html'))
      state = saved
    }
  }
  catch (e) { if (e.code !== 'ENOENT') log('HTML 状态不可用，保留原 PPT 播放：', e.message) }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(JSON.stringify(body))
  }
  async function metadata(version) {
    if (!VERSION_RE.test(version || '')) throw fail(400, 'HTML 版本编号无效')
    try { return JSON.parse(await fsp.readFile(path.join(versionsDir, version, 'meta.json'), 'utf8')) }
    catch { throw fail(404, 'HTML 版本不存在') }
  }
  async function snapshot() {
    const active = state.activeVersion ? await metadata(state.activeVersion).catch(() => null) : null
    return { ...state, active, exists: !!active }
  }
  async function saveState(next) {
    const tmp = `${stateFile}.${crypto.randomUUID()}.tmp`
    try {
      await fsp.writeFile(tmp, JSON.stringify(next, null, 2))
      await fsp.rename(tmp, stateFile)
    }
    finally { await fsp.rm(tmp, { force: true }).catch(() => {}) }
    state = next
    const notice = `event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`
    for (const client of clients) { try { client.write(notice) } catch { clients.delete(client) } }
  }
  function authorized(req) {
    // Same-origin browser writes, plus explicit development origins. Never accept opaque iframe origins.
    const origin = req.headers.origin
    const hostOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`
    const pubOrigin = (() => { try { return new URL(publicUrl).origin } catch { return '' } })()
    if (origin && (origin === 'null' || ![hostOrigin, pubOrigin, ...allowedOrigins].includes(origin))) {
      throw fail(403, '拒绝非可信来源的写入请求')
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' && !allowedOrigins.includes(origin)) throw fail(403, '拒绝跨站写入')
    if (uploadKey) {
      const supplied = String(req.headers['x-pptist-upload-key'] || '')
      const a = Buffer.from(uploadKey), b = Buffer.from(supplied)
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail(401, '管理口令不正确或未填写')
    }
  }
  async function readBody(req, limit) {
    const size = Number(req.headers['content-length'] || 0)
    if (size > limit) { req.resume(); throw fail(413, '文件或请求内容超过大小上限') }
    const chunks = []; let length = 0
    for await (const chunk of req) {
      length += chunk.length
      if (length > limit) throw fail(413, '文件或请求内容超过大小上限')
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  async function bodyJson(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, '此接口需要 application/json')
    try { return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')) }
    catch (e) { if (e.status) throw e; throw fail(400, '请求 JSON 格式不正确') }
  }
  function serialize(fn) { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next }

  const heartBeat = setInterval(() => {
    for (const res of clients) { try { res.write(':ping\n\n') } catch { clients.delete(res) } }
  }, 25000)
  heartBeat.unref()

  const staticAssets = new Set(['admin.html', 'play.html', 'style.css', 'api.js', 'frame.js', 'admin.js', 'play.js', 'links.js', 'legacy.js'])
  async function web(res, name) {
    const raw = await fsp.readFile(path.join(WEB_DIR, name))
    const type = name.endsWith('.js') ? 'application/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.end(raw)
  }
  async function handle(req, res, url) {
    const route = url.pathname
    try {
      if (req.method === 'GET') {
        if (route.startsWith('/html-support/')) {
          const name = route.slice('/html-support/'.length)
          if (!staticAssets.has(name)) throw fail(404, '资源不存在')
          await web(res, name); return true
        }
        if (route === '/html-upload' || (route === '/upload' && url.searchParams.get('type') !== 'ppt')) {
          await web(res, 'admin.html'); return true
        }
        if (route === '/html-play' || route === '/html-preview' ||
          (route === '/play' && (url.searchParams.get('type') === 'html' || (state.mode === 'html' && url.searchParams.get('type') !== 'ppt')))) {
          await web(res, 'play.html'); return true
        }
      }
      if (!route.startsWith('/html-api/')) return false
      if (req.method === 'GET' && route === '/html-api/config') {
        json(res, 200, { apiVersion: 1, maxUploadMB: maxMB, acceptTypes: ['.html', '.htm'], authRequired: !!uploadKey, publicBaseUrl: publicUrl || null, selfContainedOnly: true })
      }
      else if (req.method === 'GET' && route === '/html-api/current') json(res, 200, await snapshot())
      else if (req.method === 'GET' && route === '/html-api/versions') {
        const names = (await fsp.readdir(versionsDir)).filter(v => VERSION_RE.test(v))
        const list = (await Promise.all(names.map(v => metadata(v).catch(() => null)))).filter(Boolean)
        list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        json(res, 200, { versions: list, ...await snapshot() })
      }
      else if (req.method === 'GET' && route === '/html-api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' })
        res.write(`event: state\ndata: ${JSON.stringify(await snapshot())}\n\n`)
        clients.add(res)
        res.on('close', () => clients.delete(res))
      }
      else if (req.method === 'GET' && /^\/html-api\/(source|file)\//.test(route)) {
        const [, , kind, version, extra] = route.split('/')
        if (extra) throw fail(404, '未知 HTML 路径')
        const meta = await metadata(version)
        const raw = await fsp.readFile(path.join(versionsDir, version, 'index.html'))
        // Uploaded HTML is never served inline with the app origin. Runtime uses a sandboxed srcdoc.
        res.writeHead(200, {
          'Content-Type': kind === 'source' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'Content-Disposition': `attachment; filename="workflow.html"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
          'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        })
        res.end(raw)
      }
      else if (req.method === 'POST' && route === '/html-api/upload') {
        authorized(req)
        if (!/^(application\/octet-stream|text\/html)(;|$)/i.test(String(req.headers['content-type'] || ''))) throw fail(415, '上传需要二进制 HTML 文件，请使用上传页面')
        const original = url.searchParams.get('filename') || ''
        const filename = path.posix.basename(original.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').trim()
        if (!filename || filename.length > 240 || !/\.html?$/i.test(filename)) throw fail(400, '仅允许 .html / .htm 文件')
        const bytes = await readBody(req, maxMB * 1024 * 1024)
        if (!bytes.length) throw fail(400, 'HTML 文件为空')
        let html
        try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch { throw fail(400, '文件不是 UTF-8 编码，请另存为 UTF-8 HTML') }
        if (html.includes('\0') || !/<html(?:\s|>)/i.test(html) || !/<(?:head|body)(?:\s|>)/i.test(html)) throw fail(400, '需要完整 HTML 文档，不能上传改后缀的图片或脚本')
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || filename).replace(/<[^>]*>/g, '').trim().slice(0, 180)
        const version = `h-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
        const meta = { version, filename, title, size: bytes.length, createdAt: new Date().toISOString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
        await serialize(async () => {
          const temp = path.join(versionsDir, `.tmp-${crypto.randomUUID()}`)
          try {
            await fsp.mkdir(temp)
            await fsp.writeFile(path.join(temp, 'index.html'), bytes)
            await fsp.writeFile(path.join(temp, 'meta.json'), JSON.stringify(meta, null, 2))
            await fsp.rename(temp, path.join(versionsDir, version))
          }
          finally { await fsp.rm(temp, { recursive: true, force: true }).catch(() => {}) }
        })
        log(`HTML 已上传（未启用）：${filename}`)
        json(res, 201, { ok: true, ...meta })
      }
      else if (req.method === 'POST' && route === '/html-api/activate') {
        authorized(req)
        const { version } = await bodyJson(req)
        await serialize(async () => {
          await metadata(version)
          await fsp.access(path.join(versionsDir, version, 'index.html'))
          await saveState({ revision: state.revision + 1, mode: 'html', activeVersion: version })
        })
        json(res, 200, { ok: true, ...await snapshot() })
      }
      else if (req.method === 'POST' && route === '/html-api/select-ppt') {
        authorized(req)
        await bodyJson(req)
        if (!getPpt()) throw fail(409, '尚无默认 PPT/PDF，请先上传')
        await serialize(() => saveState({ ...state, revision: state.revision + 1, mode: 'ppt' }))
        json(res, 200, { ok: true, ...await snapshot() })
      }
      else if (req.method === 'OPTIONS') {
        // Deliberately no cross-origin permission: HTML management is same-origin only.
        res.writeHead(204, { 'Allow': 'GET, POST, OPTIONS' }); res.end()
      }
      else json(res, 404, { error: '未知 HTML 接口' })
    }
    catch (error) {
      log('HTML 请求失败：', error.message)
      if (!res.headersSent) json(res, error.status || 500, { ok: false, error: error.message })
      else res.end()
    }
    return true
  }
  // Called only after the original PPT upload has already succeeded; no mutation of PPT data.
  handle.onPptUploaded = () => serialize(async () => {
    if (state.mode !== 'ppt') await saveState({ ...state, revision: state.revision + 1, mode: 'ppt' })
  })
  // Add navigation/switching to the old SPA at response time, without changing its compiled files.
  handle.serveLegacyIndex = async (req, res, filePath) => {
    if (path.basename(filePath) !== 'index.html') return false
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (!['/play', '/upload'].includes(u.pathname)) return false
    const html = await fsp.readFile(filePath, 'utf8')
    const tag = '<script type="module" src="/html-support/legacy.js"></script>'
    const output = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag
    const body = Buffer.from(output)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
  return handle
}
