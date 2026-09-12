/**
 * 主屏文稿 v3 资源化存储（仅主屏槽位；副屏槽位继续走 v2 信封协议，互不影响）。
 *
 * 目标：数百 MB 的大文稿“整份大 JSON”拆成——
 *   data/default-ppt/
 *   ├─ current.json                  当前版本元数据（沿用 v2 结构）
 *   ├─ assets/{sha256}.{ext}         全局内容寻址资产池（图片/视频/音频，immutable）
 *   ├─ tmp/sessions/{id}/            上传会话暂存（raw.file + bundle.json + meta.json）
 *   └─ versions/v{n}/                版本目录：bundle.json（轻结构，src=资产URL）+ raw.file + meta.json
 *
 * 会话式上传（浏览器峰值内存受控，服务端全程流式落盘）：
 *   POST /default-ppt-api/upload-sessions                     创建会话
 *   PUT  /default-ppt-api/upload-sessions/{id}/assets/{sha.ext}   资产二进制（流式+校验+秒传去重）
 *   PUT  /default-ppt-api/upload-sessions/{id}/raw            原始文件（流式）
 *   PUT  /default-ppt-api/upload-sessions/{id}/bundle         轻结构 JSON（src 均为资产 URL）
 *   POST /default-ppt-api/upload-sessions/{id}/commit         原子发布（切 current.json + SSE 通知）
 *   DELETE /default-ppt-api/upload-sessions/{id}              放弃会话
 *
 * 读取（版本固定、内容不可变，可长缓存）：
 *   GET /default-ppt-api/assets/{sha.ext}                     immutable + ETag
 *   GET /default-ppt-api/versions/{v}/bundle.json             immutable
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const SESSION_RE = /^[a-f0-9-]{16,40}$/
const VERSION_RE = /^v\d+$/
const ASSET_RE = /^([a-f0-9]{64})\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|mp3|wav|m4a|aac|ogg)$/i
const MAX_BUNDLE_JSON = 128 * 1024 * 1024

const fail = (status, message) => Object.assign(new Error(message), { status })

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  aac: 'audio/aac', ogg: 'audio/ogg',
}

/** 流式读取请求体到文件：边写盘边计算 SHA256，超过 maxBytes 立即断开 */
function streamBodyToFile(req, filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = parseInt(req.headers['content-length'] || '0', 10) || 0
    if (declared > maxBytes) {
      reject(fail(413, `内容超过大小上限（约 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
      req.destroy()
      return
    }
    const hash = crypto.createHash('sha256')
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
    const stream = fs.createWriteStream(tmp)
    let size = 0
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (error) {
        stream.destroy()
        fsp.rm(tmp, { force: true }).catch(() => {})
        reject(error)
        return
      }
      stream.end(() => resolve({ ...result, tmp, size }))
    }
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBytes) {
        finish(fail(413, `内容超过大小上限（约 ${Math.round(maxBytes / 1024 / 1024)}MB）`))
        req.destroy()
        return
      }
      hash.update(chunk)
      if (!stream.write(chunk)) {
        req.pause()
        stream.once('drain', () => req.resume())
      }
    })
    req.on('end', () => finish(null, { sha256: hash.digest('hex') }))
    req.on('error', error => finish(error))
    stream.on('error', error => finish(error))
  })
}

const settle = (tmp, dest) => fsp.rename(tmp, dest)

export function createDefaultPptV3({ store, dataDir, maxUploadBytes, log, gifTranscoder }) {
  const assetsDir = path.join(dataDir, 'assets')
  const sessionsDir = path.join(dataDir, 'tmp', 'sessions')

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  async function init() {
    await fsp.mkdir(assetsDir, { recursive: true })
    await fsp.mkdir(sessionsDir, { recursive: true })
    // 清理进程崩溃遗留的资产临时文件（点开头，不可被 GET 命中）
    for (const name of await fsp.readdir(assetsDir).catch(() => [])) {
      if (name.startsWith('.') && name.endsWith('.asset-tmp')) {
        await fsp.rm(path.join(assetsDir, name), { force: true }).catch(() => {})
      }
    }
    // 清理超过 24 小时的遗留会话（进程重启后补偿）
    const cutoff = Date.now() - 24 * 3600 * 1000
    for (const name of await fsp.readdir(sessionsDir).catch(() => [])) {
      const dir = path.join(sessionsDir, name)
      const stat = await fsp.stat(dir).catch(() => null)
      if (stat?.isDirectory() && stat.mtimeMs < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /** 流式输出不可变文件（资产/版本 bundle），带 immutable 缓存与 ETag */
  function serveImmutable(req, res, filePath, contentType, etag) {
    fsp.stat(filePath).then(stat => {
      if (!stat.isFile()) { sendJson(res, 404, { error: '资源不存在' }); return }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      })
      if (req.method === 'HEAD') { res.end(); return }
      fs.createReadStream(filePath).pipe(res)
    }).catch(() => sendJson(res, 404, { error: '资源不存在' }))
  }

  async function handle(req, res, url) {
    const route = url.pathname
    try {
      // ---- 全局资产池（内容寻址，不可变） ----
      const assetMatch = route.match(/^\/default-ppt-api\/assets\/([^/]+)$/)
      if (assetMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const name = decodeURIComponent(assetMatch[1])
        if (!ASSET_RE.test(name)) { sendJson(res, 400, { error: '非法资产名' }); return true }
        const ext = name.split('.').pop().toLowerCase()
        serveImmutable(req, res, path.join(assetsDir, name), MIME_BY_EXT[ext] || 'application/octet-stream', `"${name.split('.')[0]}"`)
        return true
      }

      // ---- 版本固定 bundle（不可变） ----
      const bundleMatch = route.match(/^\/default-ppt-api\/versions\/(v\d+)\/bundle\.json$/)
      if (bundleMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const version = bundleMatch[1]
        if (!VERSION_RE.test(version)) { sendJson(res, 400, { error: '非法版本号' }); return true }
        serveImmutable(req, res, path.join(store.versionsDir, version, 'bundle.json'), 'application/json; charset=utf-8', `"${version}-bundle"`)
        return true
      }

      // ---- 上传会话 ----
      const sessionMatch = route.match(/^\/default-ppt-api\/upload-sessions(?:\/([a-f0-9-]{16,40}))?(\/.*)?$/)
      if (!sessionMatch) return false
      const sessionId = sessionMatch[1]
      const sub = sessionMatch[2] || ''

      if (!sessionId && req.method === 'POST') {
        const id = crypto.randomUUID()
        await fsp.mkdir(path.join(sessionsDir, id), { recursive: true })
        await fsp.writeFile(path.join(sessionsDir, id, 'created.json'), JSON.stringify({ createdAt: new Date().toISOString() }))
        sendJson(res, 201, { ok: true, sessionId: id })
        return true
      }
      if (!sessionId || !SESSION_RE.test(sessionId)) { sendJson(res, 404, { error: '会话不存在' }); return true }
      const sessionDir = path.join(sessionsDir, sessionId)
      if (!(await fsp.stat(sessionDir).catch(() => null))) { sendJson(res, 404, { error: '会话不存在或已过期' }); return true }

      // 资产直传池（与会话解耦：内容寻址 + 幂等，中断会话不留脏数据）。
      // 服务端流式接收并计算 SHA256（浏览器端 http 局域网环境无 crypto.subtle，哈希统一由服务端做）
      if (sub === '/assets' && req.method === 'PUT') {
        const ext = String(req.headers['x-asset-ext'] || '').toLowerCase().replace(/[^a-z0-9]/g, '')
        const allowed = new Set(Object.keys(MIME_BY_EXT))
        if (!ext || !allowed.has(ext)) { sendJson(res, 400, { error: '缺少或非法的资产扩展名（X-Asset-Ext）' }); return true }
        const { sha256, tmp, size } = await streamBodyToFile(req, path.join(assetsDir, `.${crypto.randomUUID()}.asset-tmp`), maxUploadBytes)
        const name = `${sha256}.${ext}`
        const dest = path.join(assetsDir, name)
        if (await fsp.stat(dest).catch(() => null)) {
          await fsp.rm(tmp, { force: true }).catch(() => {})
          sendJson(res, 200, { ok: true, name, deduped: true, size })
        }
        else {
          await settle(tmp, dest)
          sendJson(res, 201, { ok: true, name, size })
        }
        return true
      }

      if (sub === '/raw' && req.method === 'PUT') {
        const { tmp, size } = await streamBodyToFile(req, path.join(sessionDir, 'raw.file'), maxUploadBytes)
        await settle(tmp, path.join(sessionDir, 'raw.file'))
        sendJson(res, 200, { ok: true, size })
        return true
      }

      if (sub === '/bundle' && req.method === 'PUT') {
        const { tmp, size, sha256 } = await streamBodyToFile(req, path.join(sessionDir, 'bundle.json'), MAX_BUNDLE_JSON)
        await settle(tmp, path.join(sessionDir, 'bundle.json'))
        sendJson(res, 200, { ok: true, size, sha256 })
        return true
      }

      if (!sub && req.method === 'DELETE') {
        await fsp.rm(sessionDir, { recursive: true, force: true })
        sendJson(res, 200, { ok: true })
        return true
      }

      if (sub === '/commit' && req.method === 'POST') {
        const header = { filename: '', pageCount: 0, ...JSON.parse((await readAll(req, 8192)).toString('utf8') || '{}') }
        const filename = String(header.filename || '')
        const pageCount = Number(header.pageCount)
        if (!/\.(pptx|pdf)$/i.test(filename)) { sendJson(res, 400, { error: '仅支持 .pptx / .pdf 文件名' }); return true }
        if (!Number.isInteger(pageCount) || pageCount < 1) { sendJson(res, 400, { error: '页数无效' }); return true }

        const bundlePath = path.join(sessionDir, 'bundle.json')
        const rawPath = path.join(sessionDir, 'raw.file')
        const bundleStat = await fsp.stat(bundlePath).catch(() => null)
        const rawStat = await fsp.stat(rawPath).catch(() => null)
        if (!bundleStat || !rawStat) { sendJson(res, 400, { error: '会话不完整：bundle 或原始文件缺失' }); return true }
        // 轻结构 bundle 必须是合法 JSON 且页面中的图片 src 已全部是资产 URL（不允许 base64 混入）
        const bundleText = await fsp.readFile(bundlePath, 'utf8')
        let bundle
        try { bundle = JSON.parse(bundleText) } catch { sendJson(res, 400, { error: 'bundle 不是合法 JSON' }); return true }
        if (!bundle || !Array.isArray(bundle.slides) || !bundle.slides.length) { sendJson(res, 400, { error: 'bundle.slides 缺失' }); return true }
        if (bundleText.length > MAX_BUNDLE_JSON) { sendJson(res, 400, { error: 'bundle 超过大小上限' }); return true }

        // 引用的资产必须已存在于池中（缺失即拒绝发布，播放端不会遇到 404）
        const referenced = new Set()
        const collectSrc = value => {
          if (!value) return
          if (typeof value === 'string') {
            if (value.startsWith('/default-ppt-api/assets/')) referenced.add(decodeURIComponent(value.split('/').pop()))
            else if (value.startsWith('data:')) throw fail(400, 'bundle 中不允许残留 data: 内嵌资源')
            else if (value.startsWith('blob:')) throw fail(400, 'bundle 中不允许残留 blob: 引用')
          }
          else if (Array.isArray(value)) value.forEach(collectSrc)
          else if (typeof value === 'object') Object.values(value).forEach(collectSrc)
        }
        try { collectSrc(bundle.slides); collectSrc(bundle.theme) } catch (error) {
          sendJson(res, error.status || 400, { ok: false, error: error.message }); return true
        }
        for (const name of referenced) {
          if (!(await fsp.stat(path.join(assetsDir, name)).catch(() => null))) {
            sendJson(res, 400, { error: `资产未上传：${name}` }); return true
          }
        }

        const meta = await store.publishVersion({ filename, pageCount, files: { bundlePath, rawPath }, kind: 'v3' })
        await fsp.rm(sessionDir, { recursive: true, force: true }).catch(() => {})
        log(`v3 上传成功：${meta.version} ${filename}（${pageCount} 页，资产 ${referenced.size} 个）`)
        sendJson(res, 200, { ok: true, ...store.publicMeta() })
        // 发布成功后异步升级超大 GIF 覆盖层为视频（不阻塞响应；完成后以新 seq 热替换）
        if (gifTranscoder) scheduleGifUpgrade(meta.version)
        return true
      }

      sendJson(res, 404, { error: '未知会话接口' })
      return true
    }
    catch (error) {
      log('v3 上传请求失败：', error.message)
      if (!res.headersSent) sendJson(res, error.status || 500, { ok: false, error: error.message })
      else res.end()
      return true
    }
  }

  /** GIF→视频升级：串行；转码+改写 bundle 后用新 seq 重新发布，播放端热替换 */
  function scheduleGifUpgrade(version) {
    void gifTranscoder.enqueue(async () => {
      try {
        const bundlePath = path.join(store.versionsDir, version, 'bundle.json')
        const bundle = JSON.parse(await fsp.readFile(bundlePath, 'utf8'))
        const changed = await gifTranscoder.upgradeBundleOverlays(bundle)
        if (!changed) return
        await store.republishWithBundle(JSON.stringify(bundle))
        log(`[gif-transcode] ${version} 超大 GIF 已升级为视频并重新发布`)
      }
      catch (error) {
        log('[gif-transcode] 升级失败，GIF 保持原状：', error.message)
      }
    })
  }

  return { init, handle }
}

function readAll(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', c => { size += c.length; if (size > limit) { reject(fail(413, '请求头过大')); req.destroy(); return } chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
