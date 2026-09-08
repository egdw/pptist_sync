import { uid } from './api.js'

// This adapter runs *inside* the opaque-origin sandbox, never in the teacher app's origin.
function bootstrap(token, parentOrigin, audience) {
  const errors = []
  let ready = false, last = '', timer
  const send = (kind, payload = {}) => parent.postMessage({ type: 'pptist:html:' + kind, token, ...payload }, parentOrigin === 'null' ? '*' : parentOrigin)
  addEventListener('error', e => { if (e.error) errors.push(String(e.message).slice(0, 200)) })
  function state() {
    const api = window.ZhizhengFlow
    if (api && typeof api.getState === 'function') {
      const s = api.getState()
      const count = Math.max(1, Math.min(10000, Number(s.pageCount) || 1))
      const index = Math.max(0, Math.min(count - 1, Number(s.pageIndex) || 0))
      return { pageIndex: index, pageNumber: index + 1, pageCount: count, title: String(s.title || document.title).slice(0, 500), capable: true, activeWorker: s.activeWorker || 0, activeWorkers: Array.isArray(s.activeWorkers) ? s.activeWorkers.slice(0, 4) : [], overviewOverlay: !!s.overviewOverlay }
    }
    return { pageIndex: 0, pageNumber: 1, pageCount: 1, title: document.title || 'HTML 网页', capable: false, activeWorker: 0, activeWorkers: [], overviewOverlay: false }
  }
  function inspect() {
    try {
      const s = state(), serialized = JSON.stringify(s)
      if (!ready && errors.length && !s.capable) { send('error', { message: errors[0] }); return }
      if (!ready) { ready = true; send('ready', { state: s }) }
      else if (serialized !== last) send('state', { state: s })
      last = serialized
    }
    catch (e) { send('error', { message: String(e.message).slice(0, 200) }) }
  }
  addEventListener('message', e => {
    if (e.source !== parent || e.origin !== parentOrigin || e.data?.token !== token || e.data?.type !== 'pptist:html:command') return
    const { command, value } = e.data, api = window.ZhizhengFlow
    try {
      if (command === 'focus') { window.focus(); return }
      if (command === 'state') { send('state', { state: state() }); return }
      if (!api) return
      if (command === 'next' && typeof api.next === 'function') api.next()
      if (command === 'prev' && typeof api.prev === 'function') api.prev()
      if (command === 'goto' && Number.isInteger(value) && value >= 0 && value < state().pageCount) api.goTo(value)
      if (command === 'overview' && typeof api.showOverview === 'function') api.showOverview()
      if (command === 'directory') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
      if (command === 'worker' && Number.isInteger(value) && value >= 1 && value <= 4) api.setWorker?.(value)
      if (command === 'sync' && value && Number.isInteger(value.pageIndex)) {
        const now = state()
        if (now.pageIndex !== value.pageIndex) api.goTo(value.pageIndex)
        if (!!value.overviewOverlay !== state().overviewOverlay) api.showOverview?.()
        if (value.activeWorker >= 1 && value.activeWorker <= 4 && state().activeWorker !== value.activeWorker) api.setWorker?.(value.activeWorker)
      }
      inspect()
    }
    catch (err) { send('error', { message: String(err.message).slice(0, 200) }) }
  })
  addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'f' && !e.target.matches('input,textarea,select,[contenteditable]')) {
      e.preventDefault(); e.stopImmediatePropagation(); send('fullscreen')
    }
    if (audience && !['F11', 'Escape', 'F5'].includes(e.key)) { e.preventDefault(); e.stopImmediatePropagation() }
  }, true)
  addEventListener('pointermove', e => { if (e.clientY < 72) send('toolbar') }, { passive: true })
  addEventListener('pagehide', () => clearInterval(timer))
  addEventListener('load', () => {
    if (audience) {
      const style = document.createElement('style'); style.textContent = 'body{pointer-events:none!important}'; document.head.append(style)
    }
    setTimeout(() => { inspect(); timer = setInterval(inspect, 120) }, 0)
  }, { once: true })
}

export function prepareDocument(raw, token, audience = false) {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll('base, meta[http-equiv]').forEach(n => n.remove())
  const csp = doc.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  doc.head.prepend(csp)
  const bridge = doc.createElement('script')
  bridge.textContent = `;(${bootstrap.toString()})(${JSON.stringify(token)},${JSON.stringify(location.origin)},${JSON.stringify(audience)});`
  csp.after(bridge)
  return '<!doctype html>\n' + doc.documentElement.outerHTML
}

export class HtmlFrame {
  constructor(raw, { container, audience = false, onReady, onState, onError, onFullscreen, onToolbar } = {}) {
    this.token = uid(); this.ready = false; this.state = null
    this.node = document.createElement('iframe'); this.node.title = 'HTML 工作流程'
    this.node.className = 'workflow-frame'
    this.node.setAttribute('sandbox', 'allow-scripts')
    this.node.setAttribute('allow', 'fullscreen')
    this.node.setAttribute('referrerpolicy', 'no-referrer')
    this.node.srcdoc = prepareDocument(raw, this.token, audience)
    this.receive = e => {
      if (e.source !== this.node.contentWindow || e.origin !== 'null' || e.data?.token !== this.token) return
      const m = e.data
      if (m.type === 'pptist:html:error') { onError?.(String(m.message).slice(0, 200)); return }
      if (m.type === 'pptist:html:fullscreen') { onFullscreen?.(); return }
      if (m.type === 'pptist:html:toolbar') { onToolbar?.(); return }
      if (!['pptist:html:ready', 'pptist:html:state'].includes(m.type)) return
      const s = m.state
      if (!s || !Number.isInteger(s.pageIndex) || !Number.isInteger(s.pageCount) || s.pageCount < 1 || s.pageCount > 10000 || s.pageIndex < 0 || s.pageIndex >= s.pageCount) return
      this.state = { pageIndex: s.pageIndex, pageNumber: s.pageIndex + 1, pageCount: s.pageCount, capable: !!s.capable, title: String(s.title || '').slice(0, 500), overviewOverlay: !!s.overviewOverlay, activeWorker: Number.isInteger(s.activeWorker) ? s.activeWorker : 0, activeWorkers: Array.isArray(s.activeWorkers) ? s.activeWorkers.filter(v => Number.isInteger(v) && v >= 1 && v <= 4).slice(0, 4) : [] }
      if (!this.ready) { this.ready = true; clearTimeout(this.timeout); onReady?.(this.state) }
      else onState?.(this.state)
    }
    addEventListener('message', this.receive)
    this.timeout = setTimeout(() => { if (!this.ready) onError?.('HTML 未能在 15 秒内完成加载，旧画面已保留。请先预览检查。') }, 15000)
    container.append(this.node)
  }
  command(command, value) {
    // The recipient has an opaque origin; only the exact iframe WindowProxy receives this message.
    this.node.contentWindow?.postMessage({ type: 'pptist:html:command', token: this.token, command, value }, '*')
  }
  destroy() { clearTimeout(this.timeout); removeEventListener('message', this.receive); this.node.remove() }
}
