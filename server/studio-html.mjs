/** HTML content support for the EXISTING Studio theme library.
 * Uploaded scripts are never evaluated on the server. Only application/json
 * metadata is parsed; execution happens in an opaque-origin browser sandbox.
 */
import crypto from 'node:crypto'

export const HTML_MAX_BYTES = 32 * 1024 * 1024
export const HTML_META_FILE = '.showflow-html.json'
// LCD remains exclusively in original Markdown metadata; HTML is display-only.

function jsonBlock(html, id) {
  const scripts = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)
  for (const [, attrs, body] of scripts) {
    const attributes = Object.fromEntries([...attrs.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [m[1].toLowerCase(), m[2] ?? m[3]]))
    if (attributes.id !== id) continue
    if (attributes.type?.toLowerCase() !== 'application/json') throw new Error(`${id} 必须为 application/json；不执行上传脚本`)
    try { return JSON.parse(body) } catch { throw new Error(`${id} 不是有效 JSON`) }
  }
  return null
}
function text(value, max = 160) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
export function validateHtmlManifest(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new Error('HTML 页面清单必须包含 1—500 页')
  const ids = new Set()
  return input.map((p, i) => {
    if (!p || typeof p !== 'object') throw new Error('页面清单项无效')
    const id = text(p.id, 160)
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id) || ids.has(id)) throw new Error(`HTML 稳定页面 ID 缺失、重复或非法：${id}`)
    ids.add(id)
    return { id, index: i + 1, title: text(p.title) || `页面 ${i + 1}`, subtitle: text(p.subtitle, 240), stage: text(p.stage, 100), tabletScene: text(p.tabletScene, 100) || undefined }
  })
}

export function inspectHtml(data, filename = 'page.html') {
  if (!Buffer.isBuffer(data) || !data.length || data.length > HTML_MAX_BYTES) throw new Error('HTML 必须为小于 32MB 的非空文件')
  let html
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { throw new Error('HTML 必须使用 UTF-8 编码') }
  if (html.includes('\0') || !/<html\b/i.test(html) || !/<body\b/i.test(html)) throw new Error('请上传完整 HTML 文档（包含 html 和 body）')
  const custom = jsonBlock(html, 'showflow-manifest')
  const flow = jsonBlock(html, 'flow-data')
  let adapter = 'static', pages, warning = ''
  if (custom) {
    if (custom.format !== 'showflow-html/1.0' || !['showflow', 'zhizheng', 'static'].includes(custom.adapter)) throw new Error('showflow-manifest 的 format / adapter 不受支持')
    adapter = custom.adapter
    pages = custom.pages
    if (adapter === 'static' && pages?.length !== 1) throw new Error('静态 HTML 只能声明一页；多页必须提供控制接口')
  }
  else if (flow) {
    if (!Array.isArray(flow.pages) || !Array.isArray(flow.chapters) || !Array.isArray(flow.team) || !/window\.ZhizhengFlow\s*=/.test(html)) throw new Error('flow-data 不完整，或缺少 ZhizhengFlow 控制接口')
    adapter = 'zhizheng'
    pages = flow.pages.map((p, i) => {
      if (p.index !== undefined && p.index !== i) throw new Error('flow-data 的 index 必须与实际页面顺序一致')
      const chapter = flow.chapters[p.chapter ?? Math.max(0, p.checkpoint ?? 0)]
      const stage = p.kind === 'cover' || p.kind === 'team' ? '项目介绍' : p.kind === 'closing' ? '工作完成' : text(chapter?.title)
      return { id:p.id, title:p.title, stage, subtitle:p.desc || '' }

    })
  }
  else {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || filename.replace(/\.html?$/i, '')
    pages = [{ id: 'html-page', title }]
    warning = '未发现多页控制清单，按单页 HTML 显示；不是自动识别到多页。智证先锋最终版可自动识别全部 16 页。'
  }
  const manifest = validateHtmlManifest(pages)
  let protocolPageMap
  if (custom?.protocolPageMap) {
    if (!custom.protocolPageMap || typeof custom.protocolPageMap !== 'object' || Array.isArray(custom.protocolPageMap)) throw new Error('protocolPageMap 必须为 ID 对象')
    protocolPageMap = Object.create(null)
    for (const [source, target] of Object.entries(custom.protocolPageMap)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(source) || typeof target !== 'string' || !manifest.some(p=>p.id===target)) throw new Error('protocolPageMap 存在无效 ID')
      protocolPageMap[source] = target
    }
  }
  return { kind: 'html', adapter, manifest, protocolPageMap, pageCount: manifest.length, filename, name: filename.replace(/\.html?$/i, ''), fingerprint: crypto.createHash('sha256').update(data).digest('hex'), warning }
}
