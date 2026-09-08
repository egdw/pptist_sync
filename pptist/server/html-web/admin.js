import { $, text, request, upload, source, setKey, subscribe } from './api.js'
import { HtmlFrame } from './frame.js'
let file = null, busy = false, config = null, current = null, candidate = null, preview = null, selection = 0
function message(value, type = '') { text($('#message'), value); $('#message').className = 'message ' + type }
function readyUpload() { $('#upload').disabled = busy || !file || !config }
function choose(f) {
  if (busy) return
  file = null
  if (!f || !/\.html?$/i.test(f.name)) { message('请选择 .html / .htm 文件，不能上传截图或压缩包。', 'error'); readyUpload(); return }
  if (!f.size || f.size > (config?.maxUploadMB || 32) * 1024 * 1024) { message('文件为空或超过上传上限。', 'error'); readyUpload(); return }
  file = f; $('#chosen').hidden = false; text($('#chosen'), `${f.name} · ${(f.size / 1048576).toFixed(2)} MB`)
  message('文件已选择，上传后先预览，再确认启用。'); readyUpload()
}
$('#file').onchange = e => { choose(e.target.files[0]); e.target.value = '' }
$('#drop').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click() } }
$('#drop').ondragover = e => { e.preventDefault(); $('#drop').classList.add('dragging') }
$('#drop').ondragleave = () => $('#drop').classList.remove('dragging')
$('#drop').ondrop = e => { e.preventDefault(); $('#drop').classList.remove('dragging'); choose(e.dataTransfer.files[0]) }
$('#key').oninput = e => setKey(e.target.value)
$('#upload').onclick = async () => {
  if (!file || busy) return
  busy = true; readyUpload(); $('#progress').hidden = false; message('正在上传文件…')
  try {
    const saved = await upload(file, p => { $('#progress').value = p })
    message('上传成功，尚未启用。请查看下方预览。', 'success')
    await refresh(); await showPreview(saved)
  }
  catch (e) { message(e.message, 'error') }
  finally { busy = false; readyUpload() }
}
function updatePage(s) { text($('#preview-page'), `${s.pageNumber} / ${s.pageCount}`); $('#preview-prev').disabled = !s.capable; $('#preview-next').disabled = !s.capable }
async function showPreview(meta) {
  const id = ++selection; candidate = meta; preview?.destroy(); preview = null
  $('#preview-card').hidden = false; text($('#preview-name'), meta.filename); $('#activate').disabled = true
  $('#preview-tab').href = '/html-preview?version=' + encodeURIComponent(meta.version)
  text($('#preview-state'), '正在加载隔离预览…')
  try {
    const raw = await source(meta.version)
    if (id !== selection) return
    preview = new HtmlFrame(raw, {
      container: $('#preview-frame'),
      onReady: s => { if (id !== selection) return; updatePage(s); text($('#preview-state'), s.capable ? `网页可操作，共 ${s.pageCount} 个画面。确认后才会替换大屏。` : '普通 HTML 网页可显示；未提供内部页码控制接口。'); $('#activate').disabled = false },
      onState: updatePage,
      onError: m => { $('#activate').disabled = true; text($('#preview-state'), '预览失败：' + m) },
      onFullscreen: () => { $('#preview-frame').requestFullscreen?.().catch(() => {}) },
    })
    $('#preview-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  catch (e) { text($('#preview-state'), e.message) }
}
$('#preview-prev').onclick = () => preview?.command('prev')
$('#preview-next').onclick = () => preview?.command('next')
$('#activate').onclick = async () => {
  if (!candidate || !preview?.ready || busy) return
  if (!confirm(`将「${candidate.filename}」设为当前大屏？已打开的播放页会切换到此版本。`)) return
  busy = true; $('#activate').disabled = true; readyUpload()
  try { await request('/activate', { version: candidate.version }); message('已启用。打开的 /play 页面会自动加载新版 HTML。', 'success'); text($('#preview-state'), '已设为当前大屏，后续更新重复“上传 → 预览 → 启用”即可。'); await refresh() }
  catch (e) { message(e.message, 'error') }
  finally { busy = false; $('#activate').disabled = false; readyUpload() }
}
$('#select-ppt').onclick = async () => {
  if (!confirm('切回之前上传的 PPT/PDF？HTML 文件和历史版本会保留。')) return
  try { await request('/select-ppt', {}); await refresh(); message('已切回原 PPT/PDF 播放流程。', 'success') }
  catch (e) { message(e.message, 'error') }
}
function showCurrent(s) {
  current = s; text($('#current-mode'), s.mode === 'html' ? 'HTML 工作流程' : 'PPT / PDF')
  text($('#current-file'), s.mode === 'html' ? s.active?.filename || '暂无 HTML' : '原默认文稿（由原 PPT 上传入口管理）')
  text($('#current-time'), s.mode === 'html' ? '已保存，可在服务器重启后继续使用' : '上传 HTML 不会覆盖原文稿')
}
async function refresh() {
  try {
    const data = await request('/versions'); showCurrent(data); const tbody = $('#versions'); tbody.replaceChildren()
    if (!data.versions.length) { const tr = tbody.insertRow(); const td = tr.insertCell(); td.colSpan = 5; text(td, '还没有上传 HTML 文件'); return }
    for (const v of data.versions) {
      const tr = tbody.insertRow(); text(tr.insertCell(), v.filename); text(tr.insertCell(), new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })); text(tr.insertCell(), (v.size / 1048576).toFixed(2) + ' MB')
      const td = tr.insertCell(), badge = document.createElement('span'); badge.className = 'tag' + (data.mode === 'html' && data.activeVersion === v.version ? '' : ' saved'); text(badge, data.mode === 'html' && data.activeVersion === v.version ? '当前大屏' : '已保存'); td.append(badge)
      const actions = tr.insertCell(), b = document.createElement('button'); text(b, '预览 / 启用'); b.onclick = () => showPreview(v); actions.append(b)
      const a = document.createElement('a'); a.href = '/html-api/file/' + v.version; text(a, '原文件'); actions.append(a)
    }
  }
  catch (e) { message(e.message, 'error') }
}
$('#refresh').onclick = refresh
try { config = await request('/config'); text($('#limit'), `支持 .html / .htm · 上限 ${config.maxUploadMB} MB · 自包含网页`); $('#key-field').hidden = !config.authRequired; readyUpload() }
catch (e) { message('HTML 接口不可用：' + e.message, 'error') }
await refresh()
subscribe(s => { showCurrent(s); refresh() })
addEventListener('pagehide', () => preview?.destroy())
