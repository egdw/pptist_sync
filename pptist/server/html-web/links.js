/* HTML-only publish adapter. Does not change the teacher's PPT transports or stored config.
   MQTT scope: MQTT 3.1.1 over WebSocket, clean-session publisher, QoS 0/1/2, keepalive/reconnect.
   Four-field application messages match the original event/page/id/notes protocol. */
import { uid } from './api.js'
const enc = new TextEncoder()
const u16 = v => new Uint8Array([v >> 8, v & 255])
function concat(...parts) { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length } return out }
function string(s) { const b = enc.encode(s); if (b.length > 65535 || s.includes('\0')) throw new Error('MQTT 字段过长或含无效字符'); return concat(u16(b.length), b) }
function packet(header, payload = new Uint8Array()) {
  let len = payload.length; const bytes = []
  do { let b = len % 128; len = Math.floor(len / 128); if (len) b |= 128; bytes.push(b) } while (len)
  return concat(new Uint8Array([header, ...bytes]), payload)
}
export function loadLinks() {
  const defaults = { mqtt: { enabled: false, url: 'ws://', username: '', password: '', clientId: '', topic: 'presentation/events', qos: 1, retain: false }, ws: { enabled: false, url: 'ws://', token: '' }, rememberCredentials: false }
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('PPTIST_HTML_PRESENTATION_LINK') || localStorage.getItem('PPTIST_PRESENTATION_LINK') || '{}') } catch { /* defaults */ }
  const c = { ...defaults, ...saved, mqtt: { ...defaults.mqtt, ...saved.mqtt }, ws: { ...defaults.ws, ...saved.ws } }
  if (!c.rememberCredentials) { c.mqtt.password = ''; c.ws.token = '' }
  if (![0, 1, 2].includes(c.mqtt.qos)) c.mqtt.qos = 1
  return c
}
export function saveLinks(c) {
  const copy = JSON.parse(JSON.stringify(c))
  if (!copy.rememberCredentials) { copy.mqtt.password = ''; copy.ws.token = '' }
  localStorage.setItem('PPTIST_HTML_PRESENTATION_LINK', JSON.stringify(copy))
}
function validUrl(raw) { const u = new URL(raw); if (!['ws:', 'wss:'].includes(u.protocol)) throw new Error('地址必须是 ws:// 或 wss://'); if (!u.hostname) throw new Error('缺少服务器地址'); return u }

class PublishChannel {
  constructor(kind, config, changed, reconnect) { this.kind = kind; this.c = config; this.changed = changed; this.reconnect = reconnect; this.stopped = false; this.ready = false; this.socket = null; this.waiting = new Map(); this.packetId = 0; this.attempt = 0; this.pending = new Uint8Array(); this.connect() }
  status(s) { this.changed(this.kind, s) }
  connect() {
    if (this.stopped) return
    if (!this.c.enabled) { this.status('未启用'); return }
    try {
      const url = validUrl(this.c.url)
      if (this.kind === 'mqtt' && (!this.c.topic || /[#+\0]/.test(this.c.topic))) throw new Error('MQTT 发布主题不能为空或包含通配符')
      if (this.kind === 'ws' && this.c.token) url.searchParams.set('token', this.c.token)
      this.status('连接中')
      const socket = new WebSocket(url, this.kind === 'mqtt' ? ['mqtt'] : [])
      this.socket = socket; socket.binaryType = 'arraybuffer'; this.pending = new Uint8Array()
      this.handshakeTimer = setTimeout(() => socket.close(), 10000)
      socket.onopen = () => {
        if (this.stopped || this.socket !== socket) return
        if (this.kind === 'ws') { this.connected(); return }
        try {
          const auth = !!(this.c.username || this.c.password)
          const flags = 2 | (auth ? 128 : 0) | (this.c.password ? 64 : 0)
          const body = [string('MQTT'), new Uint8Array([4, flags, 0, 30]), string(this.c.clientId || 'pptist-html-' + uid().slice(0, 12))]
          if (auth) body.push(string(this.c.username))
          if (this.c.password) body.push(string(this.c.password))
          socket.send(packet(0x10, concat(...body)))
        }
        catch (e) { this.status(e.message); socket.close() }
      }
      socket.onmessage = event => {
        if (this.kind !== 'mqtt' || this.socket !== socket) return
        try { this.consume(new Uint8Array(event.data)) }
        catch { this.status('MQTT 响应无效'); socket.close() }
      }
      socket.onerror = () => { if (this.socket === socket) this.status('连接失败 / 检查地址与凭据') }
      socket.onclose = () => {
        if (this.socket !== socket) return
        clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer)
        this.ready = false; this.waiting.clear(); this.socket = null
        if (!this.stopped) { this.status('等待重连'); this.retry = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5))) }
      }
    }
    catch (e) { this.status(e.message) }
  }
  connected() {
    clearTimeout(this.handshakeTimer); this.ready = true; this.attempt = 0; this.pingAt = 0; this.status('已连接'); this.reconnect(this.kind)
    if (this.kind === 'mqtt') this.pingTimer = setInterval(() => {
      if (this.pingAt && Date.now() - this.pingAt > 10000) { this.socket?.close(); return }
      if ([...this.waiting.values()].some(v => Date.now() - v.sent > 30000)) { this.socket?.close(); return }
      if (!this.pingAt && this.socket?.readyState === WebSocket.OPEN) { this.pingAt = Date.now(); this.socket.send(packet(0xc0)) }
    }, 15000)
  }
  consume(chunk) {
    this.pending = concat(this.pending, chunk)
    if (this.pending.length > 1048576) throw new Error('MQTT packet too large')
    while (this.pending.length >= 2) {
      let length = 0, multiplier = 1, pos = 1, b
      do {
        if (pos >= this.pending.length) return
        if (pos > 4) throw new Error('MQTT malformed length')
        b = this.pending[pos++]; length += (b & 127) * multiplier; multiplier *= 128
      } while (b & 128)
      if (this.pending.length < pos + length) return
      const header = this.pending[0], body = this.pending.slice(pos, pos + length)
      this.pending = this.pending.slice(pos + length)
      const type = header >> 4
      if (type === 2) {
        if (body.length !== 2 || body[1] !== 0) { this.status('MQTT 拒绝连接，请核对账户'); this.socket?.close(); return }
        this.connected()
      }
      else if (type === 13) this.pingAt = 0
      else if ([4, 5, 7].includes(type)) {
        if (body.length !== 2) throw new Error('bad ack')
        const id = body[0] * 256 + body[1]
        if (type === 5 && this.waiting.has(id)) { this.socket?.send(packet(0x62, u16(id))); this.waiting.set(id, { sent: Date.now(), release: true }) }
        else if (type === 4 || type === 7) this.waiting.delete(id)
      }
      else if (type === 14) this.socket?.close()
    }
  }
  send(message) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false
    try {
      const value = JSON.stringify(message)
      if (this.kind === 'ws') this.socket.send(value)
      else {
        if (this.waiting.size >= 128) return false
        const qos = this.c.qos, parts = [string(this.c.topic)]
        if (qos > 0) {
          do { this.packetId = this.packetId % 65535 + 1 } while (this.waiting.has(this.packetId))
          parts.push(u16(this.packetId)); this.waiting.set(this.packetId, { sent: Date.now() })
        }
        parts.push(enc.encode(value)); this.socket.send(packet(0x30 | qos << 1 | (this.c.retain ? 1 : 0), concat(...parts)))
      }
      return true
    }
    catch { return false }
  }
  close() { this.stopped = true; clearTimeout(this.retry); clearTimeout(this.handshakeTimer); clearInterval(this.pingTimer); if (this.ready && this.kind === 'mqtt') { try { this.socket.send(packet(0xe0)) } catch { /* ignore */ } } this.socket?.close(); this.socket = null; this.ready = false; this.waiting.clear() }
}
export class HtmlLinks {
  constructor(changed, logged) { this.changed = changed; this.logged = logged; this.channels = {}; this.last = null; this.active = false }
  apply(config) {
    Object.values(this.channels).forEach(c => c.close())
    this.channels = {}
    for (const kind of ['mqtt', 'ws']) this.channels[kind] = new PublishChannel(kind, config[kind], this.changed, k => { if (this.last && this.active) this.channels[k]?.send(this.last) })
  }
  emit(event, state) {
    const m = { event, page: state.pageNumber, id: uid(), notes: state.title || '' }
    this.active = event !== 'presentation.ended'; this.last = m
    const result = {}; for (const [k, c] of Object.entries(this.channels)) result[k] = c.send(m)
    this.logged(m, result)
  }
  close() { Object.values(this.channels).forEach(c => c.close()) }
}
