import { $, text, request, source, subscribe, uid } from './api.js'
import { HtmlFrame } from './frame.js'
import { HtmlLinks, loadLinks, saveLinks } from './links.js'
const params = new URLSearchParams(location.search)
const isPreview = location.pathname === '/html-preview'
const isAudience = params.get('mode') === 'html-audience'
const fixedHtml = location.pathname === '/html-play' || params.get('type') === 'html'
const previewVersion = isPreview ? params.get('version') : null
const myId = uid(), parentId = params.get('controller') || null
let active = null, pending = null, wanted = '', generation = 0, alive = true, toastTimer, toolbarTimer, pinned = false
let audienceState = null
const bc = !isPreview && typeof BroadcastChannel === 'function' ? new BroadcastChannel('pptist-html-display-v1') : null
const status = { ws: '未启用', mqtt: '未启用' }, logs = []
const links = !isPreview && !isAudience ? new HtmlLinks((kind, value) => { status[kind] = value; text($('#link-status'), `WebSocket：${status.ws}\nMQTT：${status.mqtt}`) }, (m, result) => { logs.unshift(`${m.event} · 第 ${m.page} 页 · WS ${result.ws ? '已发送' : '未连接'} / MQTT ${result.mqtt ? '已发送' : '未连接'}`); text($('#link-log'), logs.slice(0, 12).join('\n')) }) : null
let config = loadLinks()
links?.apply(config)
function toast(message) { text($('#toast'), message); $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5500) }
function reveal() { $('#toolbar').classList.add('visible'); clearTimeout(toolbarTimer); if (!pinned) toolbarTimer = setTimeout(() => $('#toolbar').classList.remove('visible'), 3500) }
function full() { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => toast('请点击工具栏“全屏”，或使用浏览器全屏功能。')) }
function updateUi(s) { text($('#page-label'), `${s.pageNumber} / ${s.pageCount}`); for (const id of ['previous', 'next', 'overview', 'directory']) $('#' + id).disabled = !s.capable || isAudience; document.title = `${s.title || 'HTML 工作流程'} · PPTist` }
function broadcast() { if (active?.state && !isAudience) bc?.postMessage({ type: 'state', controller: myId, version: active.version, state: active.state }) }
function receiveState(frame, s) {
  if (frame !== active) return
  const previous = active.state; active.state = s; updateUi(s)
  if (previous && previous.pageNumber !== s.pageNumber) links?.emit('slide.changed', s)
  broadcast()
}
async function showVersion(version) {
  if (!version || version === active?.version || (version === wanted && pending)) return
  wanted = version; const gen = ++generation; pending?.frame.destroy(); pending = null
  if (!active) { $('#empty').hidden = false; text($('#empty-title'), '正在读取 HTML 工作流程') }
  try {
    const raw = await source(version)
    if (gen !== generation || !alive) return
    const item = { version, frame: null, state: null }
    item.frame = new HtmlFrame(raw, {
      container: $('#stage'), audience: isAudience,
      onReady: s => {
        if (gen !== generation || !alive) { item.frame.destroy(); return }
        const previous = active
        if (previous?.state) links?.emit('presentation.ended', previous.state)
        active = item; pending = null; item.state = s; item.frame.node.classList.remove('pending-frame')
        previous?.frame.destroy(); $('#empty').hidden = true; updateUi(s)
        links?.emit('presentation.started', s)
        if (isAudience && audienceState?.version === version) item.frame.command('sync', audienceState.state)
        else if (!isAudience) { item.frame.command('focus'); broadcast() }
      },
      onState: s => receiveState(item, s),
      onError: error => {
        if (item === pending && !item.frame.ready) { item.frame.destroy(); pending = null; wanted = ''; if (!active) { text($('#empty-title'), 'HTML 加载失败'); text($('#empty-description'), error) } }
        toast(error)
      },
      onFullscreen: full, onToolbar: reveal,
    })
    item.frame.node.classList.add('pending-frame'); pending = item
  }
  catch (e) {
    if (gen !== generation) return
    wanted = ''; toast(e.message)
    if (!active) { text($('#empty-title'), '暂无可播放的 HTML'); text($('#empty-description'), e.message) }
  }
}
async function onCurrent(s) {
  if (isPreview) return
  if (!fixedHtml && s.mode !== 'html' && location.pathname === '/play') {
    links && active?.state && links.emit('presentation.ended', active.state)
    active?.frame.destroy(); active = null; location.reload(); return
  }
  if (s.activeVersion) await showVersion(s.activeVersion)
  else { text($('#empty-title'), '暂无已启用的 HTML'); text($('#empty-description'), '在上传管理页面选择 HTML，预览后点击“设为当前大屏”。') }
}
if (isPreview) { $('#preview-badge').hidden = false; $('#settings').hidden = true; $('#audience').hidden = true; showVersion(previewVersion) }
else {
  if (isAudience) { $('#settings').hidden = true; $('#audience').hidden = true; $('#preview-badge').hidden = false; text($('#preview-badge'), '观众窗口 · 跟随同一浏览器的主控页面') }
  try { await onCurrent(await request('/current')) } catch (e) { toast(e.message) }
  subscribe(onCurrent, () => { /* EventSource reconnects and receives the current state automatically. */ })
  // Poll is a safety fallback when an upstream proxy buffers SSE.
  setInterval(() => request('/current').then(onCurrent).catch(() => {}), 12000)
}
if (bc) {
  bc.onmessage = e => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (!isAudience && m.type === 'hello' && (!m.controller || m.controller === myId)) broadcast()
    if (isAudience && m.type === 'state' && (!parentId || m.controller === parentId) && typeof m.version === 'string' && m.state && Number.isInteger(m.state.pageIndex)) {
      audienceState = m
      if (active?.version === m.version) active.frame.command('sync', m.state)
      else showVersion(m.version)
    }
  }
  if (isAudience) { bc.postMessage({ type: 'hello', controller: parentId }); setInterval(() => bc.postMessage({ type: 'hello', controller: parentId }), 3000) }
}
function cmd(command) { active?.frame.command(command); active?.frame.command('focus') }
$('#previous').onclick = () => cmd('prev'); $('#next').onclick = () => cmd('next'); $('#directory').onclick = () => cmd('directory'); $('#overview').onclick = () => cmd('overview')
$('#fullscreen').onclick = full
$('#audience').onclick = () => window.open('/play?type=html&mode=html-audience&controller=' + myId, '_blank')
$('#toolbar-trigger').onpointerenter = reveal
$('#toolbar').onpointerenter = () => { pinned = true; reveal() }
$('#toolbar').onpointerleave = () => { pinned = false; reveal() }
$('#hide-toolbar').onclick = () => { pinned = false; clearTimeout(toolbarTimer); $('#toolbar').classList.remove('visible'); active?.frame.command('focus') }
addEventListener('keydown', e => {
  if ($('#link-dialog').open || e.target.matches('input,select,textarea')) return
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); full(); return }
  if (isAudience) return
  const commands = { ArrowRight: 'next', PageDown: 'next', ' ': 'next', ArrowLeft: 'prev', PageUp: 'prev', g: 'directory', o: 'overview' }
  if (commands[e.key]) { e.preventDefault(); cmd(commands[e.key]) }
})
const form = $('#link-form')
const f = name => form.elements.namedItem(name)
function fill(c) { f('wsEnabled').checked = c.ws.enabled; f('wsUrl').value = c.ws.url; f('wsToken').value = c.ws.token; f('mqttEnabled').checked = c.mqtt.enabled; f('mqttUrl').value = c.mqtt.url; f('mqttUsername').value = c.mqtt.username; f('mqttPassword').value = c.mqtt.password; f('mqttTopic').value = c.mqtt.topic; f('mqttQos').value = c.mqtt.qos; f('mqttClientId').value = c.mqtt.clientId; f('mqttRetain').checked = c.mqtt.retain; f('remember').checked = c.rememberCredentials }
$('#settings').onclick = () => { fill(config); $('#link-dialog').showModal() }
$('#close-settings').onclick = () => { $('#link-dialog').close(); active?.frame.command('focus') }
$('#import-original').onclick = () => {
  try {
    const original = JSON.parse(localStorage.getItem('PPTIST_PRESENTATION_LINK') || 'null')
    if (!original?.ws || !original?.mqtt) { toast('本浏览器还没有保存原 PPT 联动配置，请手动填写。'); return }
    const c = JSON.parse(JSON.stringify(original)); if (!c.rememberCredentials) { c.mqtt.password = ''; c.ws.token = '' } fill(c); toast('已读取，请确认后保存。未保存的凭据需要重新填写。')
  }
  catch { toast('原配置读取失败，请手动填写。') }
}
form.onsubmit = e => {
  e.preventDefault()
  config = { ws: { enabled: f('wsEnabled').checked, url: f('wsUrl').value.trim(), token: f('wsToken').value }, mqtt: { enabled: f('mqttEnabled').checked, url: f('mqttUrl').value.trim(), username: f('mqttUsername').value, password: f('mqttPassword').value, topic: f('mqttTopic').value.trim(), qos: Number(f('mqttQos').value), retain: f('mqttRetain').checked, clientId: f('mqttClientId').value.trim() }, rememberCredentials: f('remember').checked }
  saveLinks(config); links?.apply(config); toast('HTML 联动配置已保存，原 PPT 配置没有改动。')
}
reveal()
addEventListener('pagehide', () => { alive = false; if (active?.state) links?.emit('presentation.ended', active.state); links?.close(); active?.frame.destroy(); pending?.frame.destroy(); bc?.close() }, { once: true })
// A small, navigation-only host interface for approved automation (indices are 0-based).
window.PPTistHtmlPlayer = Object.freeze({ getState: () => active?.state || null, next: () => cmd('next'), prev: () => cmd('prev'), goTo: n => active?.frame.command('goto', n), version: () => active?.version || null })
