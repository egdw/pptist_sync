/**
 * 放映联动双通道：WebSocket 与 MQTT（over WebSocket）
 *
 * - 两条通道独立工作，互不影响；发送均为“发后即忘”，绝不阻塞翻页。
 * - 断线期间不缓存消息，不建立历史翻页重放队列；仅当发送瞬间通道已连接才投递。
 * - WebSocket：启用时自动重连，指数退避（1s 起、30s 封顶）。
 *   MQTT：由 MQTT.js 内置重连（固定 5s 周期，有界、不会高频重试）。
 * - 修改配置或停用通道时关闭旧连接并清理定时器。
 */
import mqtt, { type MqttClient } from 'mqtt'
import type { MqttLinkConfig, WsLinkConfig } from '@/configs/presentationLink'
import type { ChannelStatus } from './protocol'

export type ChannelId = 'mqtt' | 'ws'

export interface ChannelHooks {
  onStatus: (channel: ChannelId, status: ChannelStatus) => void
  onLog: (channel: ChannelId, level: 'info' | 'warn' | 'error', text: string) => void
  /** 通道连接（含重连）成功后回调，桥接层可用其重发本次放映最近一条状态消息 */
  onConnected: (channel: ChannelId) => void
}

const WS_BACKOFF_BASE_MS = 1000
const WS_BACKOFF_MAX_MS = 30000

function assertWsUrl(url: string): string {
  const trimmed = (url || '').trim()
  if (!/^wss?:\/\//i.test(trimmed)) {
    throw new Error('地址必须以 ws:// 或 wss:// 开头')
  }
  return trimmed
}

/** —— WebSocket 通道 —— */
export class WsLink {
  status: ChannelStatus = 'disabled'
  private socket: WebSocket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private everConnected = false
  private destroyed = false
  private config: WsLinkConfig | null = null

  constructor(private readonly hooks: ChannelHooks) {}

  /** 应用配置。启用时建立（或按新配置重建）连接；停用时关闭并清理。 */
  apply(config: WsLinkConfig) {
    const needRebuild =
      !this.config ||
      config.url !== this.config.url ||
      config.token !== this.config.token

    if (!config.enabled) {
      this.teardown('disabled')
      return
    }
    if (!needRebuild) {
      this.config = { ...config }
      return
    }

    this.teardown('disconnected')
    this.config = { ...config }
    this.connect()
  }

  /** 主动断开（保持启用状态，不再自动重连，直到再次 apply） */
  disconnect() {
    this.teardown('disconnected')
    this.config = this.config ? { ...this.config, enabled: false } : this.config
  }

  destroy() {
    this.destroyed = true
    this.teardown('disabled')
  }

  send(text: string): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(text)
      return true
    }
    catch (error) {
      this.hooks.onLog('ws', 'error', `发送失败：${(error as Error)?.message || error}`)
      return false
    }
  }

  private connect() {
    if (this.destroyed || !this.config) return
    let url: string
    try {
      url = assertWsUrl(this.config.url)
      if (this.config.token) {
        url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.config.token)
      }
    }
    catch (error) {
      this.setStatus('failed')
      this.hooks.onLog('ws', 'error', (error as Error).message)
      return
    }

    this.setStatus('connecting')
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    }
    catch (error) {
      this.setStatus('failed')
      this.hooks.onLog('ws', 'error', `创建连接失败：${(error as Error)?.message || error}`)
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempts = 0
      this.everConnected = true
      this.setStatus('connected')
      this.hooks.onLog('ws', 'info', 'WebSocket 已连接')
      this.hooks.onConnected('ws')
    }
    socket.onmessage = () => {
      // 仅发送，不处理服务端下行消息
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.scheduleRetry(!this.everConnected)
    }
    socket.onerror = () => {
      // 错误详情随后会触发 onclose，这里仅记录
      this.hooks.onLog('ws', 'warn', 'WebSocket 连接出错')
    }
  }

  private scheduleRetry(failed: boolean) {
    if (this.destroyed || !this.config?.enabled) {
      this.setStatus('disconnected')
      return
    }
    this.setStatus(failed ? 'failed' : 'reconnecting')
    const delay = Math.min(WS_BACKOFF_MAX_MS, WS_BACKOFF_BASE_MS * 2 ** this.attempts)
    this.attempts += 1
    this.hooks.onLog('ws', 'warn', `${failed ? '连接失败' : '连接断开'}，${Math.round(delay / 1000)}s 后重试`)
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private teardown(status: ChannelStatus) {
    this.clearRetryTimer()
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null
      try {
        socket.close()
      }
      catch {
        /* 忽略关闭异常 */
      }
    }
    this.attempts = 0
    this.everConnected = false
    this.setStatus(status)
  }

  private setStatus(status: ChannelStatus) {
    if (this.status === status) return
    this.status = status
    this.hooks.onStatus('ws', status)
  }
}

/** —— MQTT 通道（MQTT over WebSocket） —— */
export class MqttLink {
  status: ChannelStatus = 'disabled'
  private client: MqttClient | null = null
  private destroyed = false
  private everConnected = false
  private config: MqttLinkConfig | null = null

  constructor(private readonly hooks: ChannelHooks) {}

  apply(config: MqttLinkConfig, options: { password?: string } = {}) {
    const effective: MqttLinkConfig = { ...config }
    // 未勾选“记住凭据”时密码不落盘，运行期以会话内存中的值为准
    if (options.password !== undefined) effective.password = options.password

    const needRebuild =
      !this.config ||
      effective.enabled !== this.config.enabled ||
      effective.url !== this.config.url ||
      effective.username !== this.config.username ||
      effective.password !== this.config.password ||
      effective.clientId !== this.config.clientId

    if (!effective.enabled) {
      this.teardown('disabled')
      this.config = effective
      return
    }
    if (!needRebuild) {
      this.config = effective
      return
    }

    this.teardown('disconnected')
    this.config = effective
    this.connect()
  }

  disconnect() {
    this.teardown('disconnected')
    this.config = this.config ? { ...this.config, enabled: false } : this.config
  }

  destroy() {
    this.destroyed = true
    this.teardown('disabled')
  }

  send(text: string): boolean {
    const client = this.client
    const config = this.config
    if (!client || !config || !client.connected) return false
    try {
      client.publish(config.topic, text, { qos: config.qos, retain: config.retain })
      return true
    }
    catch (error) {
      this.hooks.onLog('mqtt', 'error', `发布失败：${(error as Error)?.message || error}`)
      return false
    }
  }

  private connect() {
    if (this.destroyed || !this.config) return
    let url: string
    try {
      url = assertWsUrl(this.config.url)
    }
    catch (error) {
      this.setStatus('failed')
      this.hooks.onLog('mqtt', 'error', (error as Error).message + '（浏览器只能通过 WebSocket 连接 Broker，如 ws://broker:8083/mqtt）')
      return
    }

    const clientId = (this.config.clientId || '').trim() || `pptist-${Math.random().toString(36).slice(2, 10)}`
    this.setStatus('connecting')
    this.hooks.onLog('mqtt', 'info', `正在连接 Broker（Client ID：${clientId}）`)

    try {
      this.client = mqtt.connect(url, {
        clientId,
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 5000,
        clean: true,
        protocolVersion: 4,
      })
    }
    catch (error) {
      this.client = null
      this.setStatus('failed')
      this.hooks.onLog('mqtt', 'error', `创建连接失败：${(error as Error)?.message || error}`)
      return
    }

    const client = this.client
    client.on('connect', () => {
      if (this.client !== client) return
      this.everConnected = true
      this.setStatus('connected')
      this.hooks.onLog('mqtt', 'info', `MQTT 已连接，发布主题：${this.config?.topic}（QoS ${this.config?.qos}${this.config?.retain ? '，retain' : ''}）`)
      this.hooks.onConnected('mqtt')
    })
    client.on('reconnect', () => {
      if (this.client !== client) return
      this.setStatus(this.everConnected ? 'reconnecting' : 'connecting')
    })
    client.on('close', () => {
      if (this.client !== client) return
      if (!this.everConnected) this.setStatus('failed')
      else this.setStatus('reconnecting')
    })
    client.on('offline', () => {
      if (this.client !== client) return
      this.setStatus(this.everConnected ? 'reconnecting' : 'failed')
    })
    client.on('error', error => {
      if (this.client !== client) return
      this.hooks.onLog('mqtt', 'error', `连接错误：${error?.message || error}`)
    })
  }

  private teardown(status: ChannelStatus) {
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      try {
        client.end(true)
      }
      catch {
        /* 忽略关闭异常 */
      }
    }
    this.everConnected = false
    this.setStatus(status)
  }

  private setStatus(status: ChannelStatus) {
    if (this.status === status) return
    this.status = status
    this.hooks.onStatus('mqtt', status)
  }
}

export interface ConnectionTestResult {
  ok: boolean
  error?: string
}

/** 通道连接测试：使用临时连接，成功或超时后立即关闭，不影响正式通道 */
export function testWsConnection(config: WsLinkConfig, timeoutMs = 8000): Promise<ConnectionTestResult> {
  return new Promise(resolve => {
    let url: string
    try {
      url = assertWsUrl(config.url)
      if (config.token) {
        url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(config.token)
      }
    }
    catch (error) {
      resolve({ ok: false, error: (error as Error).message })
      return
    }

    let settled = false
    const finish = (result: ConnectionTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      }
      catch {
        /* 忽略 */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: '连接超时' }), timeoutMs)
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    }
    catch (error) {
      finish({ ok: false, error: (error as Error)?.message || '创建连接失败' })
      return
    }
    socket.onopen = () => finish({ ok: true })
    socket.onerror = () => finish({ ok: false, error: '连接失败（地址不可达或协议不允许）' })
  })
}

export function testMqttConnection(
  config: MqttLinkConfig,
  options: { password?: string; timeoutMs?: number } = {},
): Promise<ConnectionTestResult> {
  return new Promise(resolve => {
    let url: string
    try {
      url = assertWsUrl(config.url)
    }
    catch (error) {
      resolve({ ok: false, error: (error as Error).message })
      return
    }

    const timeoutMs = options.timeoutMs ?? 8000
    const clientId = (config.clientId || '').trim() || `pptist-test-${Math.random().toString(36).slice(2, 10)}`
    let settled = false
    let client: MqttClient | null = null
    const finish = (result: ConnectionTestResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (client) {
        client.removeAllListeners()
        try {
          client.end(true)
        }
        catch {
          /* 忽略 */
        }
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, error: '连接超时' }), timeoutMs)

    try {
      client = mqtt.connect(url, {
        clientId,
        username: config.username || undefined,
        password: (options.password !== undefined ? options.password : config.password) || undefined,
        connectTimeout: timeoutMs,
        reconnectPeriod: 0,
        clean: true,
        protocolVersion: 4,
      })
    }
    catch (error) {
      finish({ ok: false, error: (error as Error)?.message || '创建连接失败' })
      return
    }
    client.on('connect', () => finish({ ok: true }))
    client.on('error', error => finish({ ok: false, error: error?.message || '连接失败' }))
  })
}
