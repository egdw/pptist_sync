/**
 * Controller 侧 WebSocket 客户端。
 * 连接 node 端 showflow-ws 服务器；服务器只做角色路由与心跳转发，
 * 所有业务（NAVIGATE/ACK/SYNC_STATE）由 Controller 收发。
 */
import { HEARTBEAT_INTERVAL_MS, OFFLINE_THRESHOLD_MS, SHOWFLOW_WS_PATH } from './protocol'
import type { ShowFlowMessage, ShowFlowRole } from './protocol'
import type { ScreenRole } from '../types'

type MessageHandler = (msg: ShowFlowMessage) => void

export interface RemoteEndpointStatus {
  connected: boolean
  lastSeen: number
}

export class ShowFlowWsClient {
  private ws: WebSocket | null = null
  private heartbeatTimer = 0
  private reconnectTimer = 0
  private closed = false
  /** 重连退避：2s 起指数递增，上限 30s；连接成功后复位。避免被拒角色/服务端离线时的重连风暴 */
  private reconnectDelay = 2000
  /** 下次 HELLO 携带 force 标记（「接管控制台」按钮） */
  private forceNextHello = false

  /** 各远端角色最近心跳时间（ms 时间戳） */
  lastSeenByRole = new Map<ShowFlowRole, number>()

  constructor(
    private url: string,
    private handlers: { onMessage: MessageHandler; onDisconnect: () => void },
  ) {}

  /** 强制接管 controller 角色：立即重连并携带 force HELLO（服务端替换占用中的旧控制台） */
  takeover() {
    this.forceNextHello = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = 0
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'HELLO', role: 'controller', force: true })
      this.forceNextHello = false
      return
    }
    this.connect()
  }

  connect() {
    this.closed = false
    try {
      this.ws = new WebSocket(this.url)
    }
    catch {
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.reconnectDelay = 2000
      const force = this.forceNextHello
      this.forceNextHello = false
      this.send({ type: 'HELLO', role: 'controller', ...(force ? { force: true } : {}) })
      this.startHeartbeat()
    }
    this.ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data) as ShowFlowMessage
        if (msg.type === 'PONG' && msg.role) this.lastSeenByRole.set(msg.role, Date.now())
        else if (msg.type === 'HELLO_ACK' && msg.role) this.lastSeenByRole.set(msg.role, Date.now())
        // 角色被占（另一控制台存活）：拉长退避，避免 2s 一次的重连风暴；服务端僵尸接管后仍会自动恢复
        if (msg.type === 'ERROR' && msg.code === 'ROLE_TAKEN') {
          this.reconnectDelay = Math.max(this.reconnectDelay, 10000)
        }
        this.handlers.onMessage(msg)
      }
      catch { /* 忽略非 JSON 帧 */ }
    }
    this.ws.onclose = () => {
      this.stopHeartbeat()
      this.handlers.onDisconnect()
      if (!this.closed) this.scheduleReconnect()
    }
    this.ws.onerror = () => this.ws?.close()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0
      this.connect()
    }, delay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      this.send({ type: 'PING', role: 'controller' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = 0
  }

  send(msg: ShowFlowMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  /** 判断某远端角色是否在线（6s 内有心跳回应） */
  isRoleOnline(role: ScreenRole): boolean {
    const last = this.lastSeenByRole.get(role as ShowFlowRole)
    if (!last) return false
    return Date.now() - last < OFFLINE_THRESHOLD_MS
  }

  destroy() {
    this.closed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = 0
    this.ws?.close()
    this.ws = null
  }
}

export function buildShowFlowWsUrl(wsBase: string): string {
  return `${wsBase.replace(/\/+$/, '')}${SHOWFLOW_WS_PATH}`
}

/** 同源 WS 地址：开发期经 vite 代理，生产期与 node 服务器同端口。控制器与副屏页共用 */
export function resolveShowFlowWsUrl(): string {
  const { protocol, hostname, port } = window.location
  const wsProto = protocol === 'https:' ? 'wss' : 'ws'
  const base = port ? `${wsProto}://${hostname}:${port}` : `${wsProto}://${hostname}`
  return buildShowFlowWsUrl(base)
}
