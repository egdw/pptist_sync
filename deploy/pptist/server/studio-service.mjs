import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'

const MAX_MARKDOWN = 5 * 1024 * 1024
const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'])

async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(temp, data)
  await fsp.rename(temp, file)
}

function safeName(value) {
  return path.basename(String(value || '')).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '-')
}

function versionId(date = new Date()) {
  return date.toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '')
}

export function createStudioService({ rootDir, revealDir, dataDir }) {
  const studioDir = path.resolve(dataDir || path.join(rootDir, 'data', 'studio'))
  const draftFile = path.join(studioDir, 'draft', 'slides.md')
  const activeFile = path.join(studioDir, 'active', 'slides.md')
  const metaFile = path.join(studioDir, 'meta.json')
  const versionsDir = path.join(studioDir, 'versions')
  const assetsDir = path.join(studioDir, 'assets')
  const themesDir = path.join(studioDir, 'themes')
  const lcdThemesDir = path.join(studioDir, 'lcd-themes')
  const defaultLcdTheme = { background: '#101b31', taskFontSize: 46, roleFontSize: 60, stageFontSize: 56, maxTaskLines: 3 }
  let writeChain = Promise.resolve()

  async function exists(file) { return !!(await fsp.stat(file).catch(() => null)) }
  async function readMeta() {
    try { return JSON.parse(await fsp.readFile(metaFile, 'utf8')) }
    catch { return { draftRevision: 1, activeRevision: 1, draftUpdatedAt: null, activeUpdatedAt: null } }
  }
  async function writeMeta(meta) { await atomicWrite(metaFile, JSON.stringify(meta, null, 2)) }

  async function init() {
    await Promise.all([draftFile, activeFile].map(file => fsp.mkdir(path.dirname(file), { recursive: true })))
    await Promise.all([fsp.mkdir(versionsDir, { recursive: true }), fsp.mkdir(assetsDir, { recursive: true }), fsp.mkdir(themesDir, { recursive: true }), fsp.mkdir(lcdThemesDir, { recursive: true })])
    const seed = await fsp.readFile(path.join(revealDir, 'slides.md'), 'utf8')
    if (!(await exists(activeFile))) await atomicWrite(activeFile, seed)
    if (!(await exists(draftFile))) await atomicWrite(draftFile, await fsp.readFile(activeFile))
    if (!(await exists(metaFile))) await writeMeta(await readMeta())
  }

  async function status() {
    const meta = await readMeta()
    const [draft, active] = await Promise.all([fsp.readFile(draftFile, 'utf8'), fsp.readFile(activeFile, 'utf8')])
    const activeTheme = meta.activeRevealTheme || 'default'
    const draftTheme = meta.draftRevealTheme || activeTheme
    const activeLcdTheme = meta.activeLcdTheme || 'default'
    const draftLcdTheme = meta.draftLcdTheme || activeLcdTheme
    return { ...meta, activeRevealTheme: activeTheme, draftRevealTheme: draftTheme, activeLcdTheme, draftLcdTheme, dirty: draft !== active || draftTheme !== activeTheme || draftLcdTheme !== activeLcdTheme, dataDir: studioDir }
  }

  async function getSlides(which = 'draft') {
    const markdown = await fsp.readFile(which === 'active' ? activeFile : draftFile, 'utf8')
    return { markdown, status: await status() }
  }

  function saveDraft(markdown) {
    if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('Markdown 不能为空')
    if (Buffer.byteLength(markdown) > MAX_MARKDOWN) throw new Error('Markdown 不能超过 5MB')
    writeChain = writeChain.then(async () => {
      await atomicWrite(draftFile, markdown.replace(/\r\n/g, '\n'))
      const meta = await readMeta()
      meta.draftRevision = Number(meta.draftRevision || 0) + 1
      meta.draftUpdatedAt = new Date().toISOString()
      await writeMeta(meta)
      return status()
    })
    return writeChain
  }

  function publish(message = '') {
    writeChain = writeChain.then(async () => {
      const markdown = await fsp.readFile(draftFile, 'utf8')
      const id = versionId()
      const target = path.join(versionsDir, id)
      await fsp.mkdir(target, { recursive: true })
      await atomicWrite(path.join(target, 'slides.md'), markdown)
      const meta = await readMeta()
      await atomicWrite(path.join(target, 'version.json'), JSON.stringify({ id, createdAt: new Date().toISOString(), message: String(message || ''), revealTheme: meta.draftRevealTheme || meta.activeRevealTheme || 'default', lcdTheme: meta.draftLcdTheme || meta.activeLcdTheme || 'default' }, null, 2))
      await atomicWrite(activeFile, markdown)
      meta.activeRevision = Number(meta.activeRevision || 0) + 1
      meta.activeUpdatedAt = new Date().toISOString()
      meta.activeVersion = id
      meta.activeRevealTheme = meta.draftRevealTheme || meta.activeRevealTheme || 'default'
      meta.activeLcdTheme = meta.draftLcdTheme || meta.activeLcdTheme || 'default'
      await writeMeta(meta)
      return status()
    })
    return writeChain
  }

  async function versions() {
    const names = await fsp.readdir(versionsDir).catch(() => [])
    const items = await Promise.all(names.sort().reverse().map(async id => {
      try { return JSON.parse(await fsp.readFile(path.join(versionsDir, id, 'version.json'), 'utf8')) }
      catch { return { id, createdAt: null, message: '' } }
    }))
    return items
  }

  async function restore(id) {
    if (!/^[0-9T_\-]+$/.test(id)) throw new Error('无效版本 ID')
    const markdown = await fsp.readFile(path.join(versionsDir, id, 'slides.md'), 'utf8')
    await saveDraft(markdown)
    const version = JSON.parse(await fsp.readFile(path.join(versionsDir, id, 'version.json'), 'utf8'))
    const meta = await readMeta()
    if (version.revealTheme) meta.draftRevealTheme = version.revealTheme
    if (version.lcdTheme) meta.draftLcdTheme = version.lcdTheme
    await writeMeta(meta)
    return status()
  }

  async function listAssets() {
    const names = await fsp.readdir(assetsDir).catch(() => [])
    return Promise.all(names.map(async name => {
      const stat = await fsp.stat(path.join(assetsDir, name))
      return { id: name, name, size: stat.size, url: `/studio-assets/${encodeURIComponent(name)}`, updatedAt: stat.mtime.toISOString() }
    }))
  }

  async function saveAsset(filename, data) {
    const name = safeName(filename)
    if (!name || !ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error('仅支持 PNG/JPG/JPEG/GIF/SVG/WebP')
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('素材必须小于 20MB')
    const target = path.join(assetsDir, name)
    await atomicWrite(target, data)
    return { name, url: `/studio-assets/${encodeURIComponent(name)}` }
  }

  async function deleteAsset(id) {
    const name = safeName(id)
    if (name !== id) throw new Error('无效素材 ID')
    await fsp.unlink(path.join(assetsDir, name))
  }

  async function listThemes() {
    const names = await fsp.readdir(themesDir).catch(() => [])
    const meta = await readMeta()
    return [{ id: 'default', name: '内置主题' }, ...names.map(id => ({ id, name: id }))].map(item => ({ ...item, active: (meta.activeRevealTheme || 'default') === item.id, draft: (meta.draftRevealTheme || meta.activeRevealTheme || 'default') === item.id }))
  }

  async function uploadTheme(filename, data) {
    if (!/\.zip$/i.test(filename || '')) throw new Error('主题必须为 ZIP')
    if (!data.length || data.length > 20 * 1024 * 1024) throw new Error('主题 ZIP 必须小于 20MB')
    const zip = new AdmZip(data)
    const entries = zip.getEntries()
    if (!entries.length || entries.length > 200) throw new Error('主题 ZIP 文件数量无效')
    let total = 0
    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/')
      const mode = (entry.attr >>> 16) & 0o170000
      if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) throw new Error('主题 ZIP 包含路径穿越或绝对路径')
      if (mode === 0o120000) throw new Error('主题 ZIP 不允许符号链接')
      total += entry.header.size
      if (entry.header.size > 5 * 1024 * 1024 || total > 30 * 1024 * 1024) throw new Error('主题解压内容过大')
      if (!entry.isDirectory && !new Set(['.css','.png','.jpg','.jpeg','.gif','.svg','.webp','.woff','.woff2','.json','.md']).has(path.extname(name).toLowerCase())) throw new Error(`主题包含非法文件：${name}`)
    }
    const cssEntry = entries.find(entry => !entry.isDirectory && /(^|\/)theme\.css$/i.test(entry.entryName))
    if (!cssEntry) throw new Error('主题 ZIP 缺少 theme.css')
    const idBase = safeName(path.basename(filename, path.extname(filename))).toLowerCase() || 'theme'
    let id = idBase, suffix = 1
    while (await exists(path.join(themesDir, id))) id = `${idBase}-${++suffix}`
    const temp = path.join(studioDir, 'tmp', `${id}-${crypto.randomUUID()}`)
    await fsp.mkdir(temp, { recursive: true })
    try {
      // 将 theme.css 所在目录作为主题根，避免 ZIP 外层目录影响引用路径。
      const prefix = cssEntry.entryName.slice(0, -'theme.css'.length)
      for (const entry of entries) {
        if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue
        const relative = entry.entryName.slice(prefix.length).replace(/\\/g, '/')
        if (!relative) continue
        const target = path.join(temp, ...relative.split('/'))
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, entry.getData())
      }
      await fsp.rename(temp, path.join(themesDir, id))
    }
    catch (error) { await fsp.rm(temp, { recursive: true, force: true }); throw error }
    return { id, name: id }
  }

  async function selectDraftTheme(id) {
    if (id !== 'default' && !(await exists(path.join(themesDir, safeName(id), 'theme.css')))) throw new Error('主题不存在')
    const meta = await readMeta(); meta.draftRevealTheme = id; await writeMeta(meta); return status()
  }

  async function deleteTheme(id) {
    const meta = await readMeta()
    if (id === 'default' || id === meta.activeRevealTheme || id === meta.draftRevealTheme) throw new Error('不能删除内置、正式或 Draft 正在使用的主题')
    await fsp.rm(path.join(themesDir, safeName(id)), { recursive: true, force: true })
  }

  async function getDraftThemeCss() {
    const meta = await readMeta(); const id = meta.draftRevealTheme || meta.activeRevealTheme || 'default'
    const file = id === 'default' ? path.join(revealDir, 'theme.css') : path.join(themesDir, id, 'theme.css')
    return { id, css: await fsp.readFile(file, 'utf8') }
  }

  async function saveDraftThemeCss(css) {
    if (typeof css !== 'string' || !css.trim() || Buffer.byteLength(css) > 1024 * 1024) throw new Error('CSS 为空或超过 1MB')
    const meta = await readMeta(); let id = meta.draftRevealTheme || meta.activeRevealTheme || 'default'
    if (id === 'default') {
      id = `custom-${Date.now().toString(36)}`
      await fsp.mkdir(path.join(themesDir, id), { recursive: true })
      meta.draftRevealTheme = id
    }
    await atomicWrite(path.join(themesDir, id, 'theme.css'), css)
    meta.draftRevealTheme = id; await writeMeta(meta)
    return { id, status: await status() }
  }

  async function exportTheme(scope = 'active') {
    const meta = await readMeta()
    const id = scope === 'draft' ? (meta.draftRevealTheme || meta.activeRevealTheme || 'default') : (meta.activeRevealTheme || 'default')
    const sourceDir = id === 'default' ? revealDir : path.join(themesDir, id)
    const zip = new AdmZip()
    async function addDirectory(dir, prefix = '') {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const absolute = path.join(dir, entry.name)
        if (entry.isDirectory()) await addDirectory(absolute, relative)
        else if (entry.isFile() && ['.css','.png','.jpg','.jpeg','.gif','.svg','.webp','.woff','.woff2','.json'].includes(path.extname(entry.name).toLowerCase())) zip.addFile(relative.replace(/\\/g, '/'), await fsp.readFile(absolute))
      }
    }
    if (id === 'default') zip.addFile('theme.css', await fsp.readFile(path.join(revealDir, 'theme.css')))
    else await addDirectory(sourceDir)
    zip.addFile('theme-manifest.json', Buffer.from(JSON.stringify({ format:'showflow-reveal-theme/1.0', id, name:id, entry:'theme.css', scope, exportedAt:new Date().toISOString(), editable:['theme.css','visual assets'], forbidden:['app.js','showflow.js','server files','Reveal core'] }, null, 2)))
    zip.addFile('AI-修改说明.md', Buffer.from('# ShowFlow Reveal 主题\n\n请主要修改 `theme.css`。可以调整颜色、字体、背景、卡片、头像、动画和页面布局。\n\n不要加入 JavaScript，不要修改 ShowFlow、WebSocket、MQTT、Manifest 或 LCD 逻辑。修改完成后保持 `theme.css` 位于 ZIP 根目录，再通过 `/studio/theme` 上传预览。\n'))
    return { id, filename: `${id}-${scope}-theme.zip`, data: zip.toBuffer() }
  }

  function validateLcdConfig(raw) {
    const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback))
    return { background: /^#[0-9a-f]{6}$/i.test(raw?.background) ? raw.background : defaultLcdTheme.background, taskFontSize: bounded(raw?.taskFontSize, 46, 24, 86), roleFontSize: bounded(raw?.roleFontSize, 60, 28, 82), stageFontSize: bounded(raw?.stageFontSize, 56, 28, 82), maxTaskLines: Math.round(bounded(raw?.maxTaskLines, 3, 1, 4)) }
  }
  async function lcdConfig(id) {
    if (!id || id === 'default') return { ...defaultLcdTheme }
    if (safeName(id) !== id) throw new Error('无效 LCD Theme ID')
    return validateLcdConfig(JSON.parse(await fsp.readFile(path.join(lcdThemesDir, id, 'lcd-theme.json'), 'utf8')))
  }
  async function listLcdThemes() {
    const meta = await readMeta(); const names = await fsp.readdir(lcdThemesDir).catch(() => [])
    return [{ id:'default', name:'内置 LCD 主题' }, ...names.map(id => ({id,name:id}))].map(item => ({...item, active:(meta.activeLcdTheme||'default')===item.id, draft:(meta.draftLcdTheme||meta.activeLcdTheme||'default')===item.id}))
  }
  async function saveLcdTheme(id, config) {
    const meta = await readMeta(); let targetId = id
    if (!targetId || targetId === 'default') targetId = `lcd-custom-${Date.now().toString(36)}`
    if (safeName(targetId) !== targetId) throw new Error('无效 LCD Theme ID')
    await atomicWrite(path.join(lcdThemesDir, targetId, 'lcd-theme.json'), JSON.stringify(validateLcdConfig(config), null, 2))
    meta.draftLcdTheme = targetId; await writeMeta(meta)
    return { id: targetId, config: await lcdConfig(targetId), status: await status() }
  }
  async function uploadLcdTheme(filename, data) {
    if (!/\.zip$/i.test(filename || '') || !data.length || data.length > 20*1024*1024) throw new Error('LCD Theme 必须为小于 20MB 的 ZIP')
    const zip = new AdmZip(data); const entries = zip.getEntries(); let total=0
    for (const entry of entries) { const name=entry.entryName.replace(/\\/g,'/'); const mode=(entry.attr>>>16)&0o170000; if(name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..'))throw new Error('LCD Theme ZIP 包含路径穿越或绝对路径'); if(mode===0o120000)throw new Error('LCD Theme ZIP 不允许符号链接'); total+=entry.header.size; if(total>10*1024*1024)throw new Error('LCD Theme 解压内容过大'); if(!entry.isDirectory&&!/\.json$/i.test(name))throw new Error('LCD Theme ZIP 仅允许 JSON') }
    const configEntry=entries.find(entry=>/(^|\/)lcd-theme\.json$/i.test(entry.entryName)); if(!configEntry)throw new Error('缺少 lcd-theme.json')
    let parsed; try{parsed=JSON.parse(configEntry.getData().toString('utf8'))}catch{throw new Error('lcd-theme.json 不是有效 JSON')}
    const id=safeName(path.basename(filename,'.zip')).toLowerCase()||`lcd-${Date.now().toString(36)}`
    return saveLcdTheme(id, parsed)
  }
  async function selectDraftLcdTheme(id) { await lcdConfig(id); const meta=await readMeta(); meta.draftLcdTheme=id; await writeMeta(meta); return {config:await lcdConfig(id),status:await status()} }
  async function deleteLcdTheme(id) { const meta=await readMeta(); if(id==='default'||id===meta.activeLcdTheme||id===meta.draftLcdTheme)throw new Error('不能删除内置、正式或 Draft 正在使用的 LCD Theme'); await fsp.rm(path.join(lcdThemesDir,safeName(id)),{recursive:true,force:true}) }
  async function activeLcdConfig() { const meta=await readMeta(); return lcdConfig(meta.activeLcdTheme||'default') }
  async function draftLcdConfig() { const meta=await readMeta(); return {id:meta.draftLcdTheme||meta.activeLcdTheme||'default',config:await lcdConfig(meta.draftLcdTheme||meta.activeLcdTheme||'default')} }

  return { studioDir, assetsDir, themesDir, lcdThemesDir, activeFile, draftFile, init, status, getSlides, saveDraft, publish, versions, restore, listAssets, saveAsset, deleteAsset, listThemes, uploadTheme, selectDraftTheme, deleteTheme, getDraftThemeCss, saveDraftThemeCss, exportTheme, lcdConfig, listLcdThemes, saveLcdTheme, uploadLcdTheme, selectDraftLcdTheme, deleteLcdTheme, activeLcdConfig, draftLcdConfig }
}
