/**
 * 放映联动桥接模块（主控窗口挂载一次的单例）
 *
 * - 在主控窗口（非观众窗口）的 App 挂载时初始化一次，监听放映状态与页码变化，
 *   由 PresentationSession 统一判定真实事件，避免在各按键/按钮中分散发送。
 * - 同一次真实事件只生成一个 id 与一份数据，向每个已连接通道各发送一次。
 * - 观众窗口（?mode=audience）不初始化本模块，因此不会对外发送。
 * - 观众窗口同步所用的 BroadcastChannel 功能不受影响，本模块不参与窗口间同步。
 * - 发送全程 try/catch，任何网络异常都不会阻塞翻页。
 */
import { reactive, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useScreenStore, useSlidesStore } from '@/store'
import { loadPresentationLinkConfig, clonePresentationLinkConfig, savePresentationLinkConfig, type PresentationLinkConfig } from '@/configs/presentationLink'
import { MqttLink, WsLink, testMqttConnection, testWsConnection, type ChannelId, type ChannelHooks, type ConnectionTestResult } from './channels'
import { PresentationSession } from './session'
import { remarkToPlainText } from './remarkText'
import { CHANNEL_STATUS_LABELS, type ChannelStatus, type PresentationEventMessage } from './protocol'

export interface LinkLogEntry {
  id: number
  time: string
  level: 'info' | 'warn' | 'error'
  channel: string
  text: string
}

export interface RecentEventEntry {
  id: string
  time: string
  event: string
  page: number
  notes: string
  mqtt: boolean
  ws: boolean
  text: string
}

const LOG_LIMIT = 200
const RECENT_EVENT_LIMIT = 20

/** 供设置界面读取的响应式状态（桥接未初始化时也可安全读取） */
export const presentationLinkState = reactive({
  inited: false,
  sessionActive: false,
  mqttStatus: 'disabled' as ChannelStatus,
  wsStatus: 'disabled' as ChannelStatus,
  logs: [] as LinkLogEntry[],
  recentEvents: [] as RecentEventEntry[],
})

let logAutoId = 0
let inited = false
let unwatchFns: Array<() => void> = []
let session: PresentationSession | null = null
let mqttLink: MqttLink | null = null
let wsLink: WsLink | null = null
// 运行期配置快照：包含未记住的密码（仅内存），通道重连时使用
let runtimeConfig: PresentationLinkConfig | null = null

function pushLog(level: LinkLogEntry['level'], channel: string, text: string) {
  const now = new Date()
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  presentationLinkState.logs.push({ id: ++logAutoId, time, level, channel, text })
  if (presentationLinkState.logs.length > LOG_LIMIT) {
    presentationLinkState.logs.splice(0, presentationLinkState.logs.length - LOG_LIMIT)
  }
}

export function clearLogs() {
  presentationLinkState.logs.splice(0)
}

const channelHooks: ChannelHooks = {
  onStatus(channel, status) {
    if (channel === 'mqtt') presentationLinkState.mqttStatus = status
    else presentationLinkState.wsStatus = status
  },
  onLog(channel, level, text) {
    pushLog(level, channel === 'mqtt' ? 'MQTT' : 'WebSocket', text)
  },
  onConnected(channel) {
    // 连接恢复时重发本次放映最近一条状态消息（沿用原 id 与原四字段数据）；
    // 首次连接且尚无放映事件时不发送任何消息。
    if (!session?.active || !session.lastMessage) return
    const message = session.lastMessage
    const text = JSON.stringify(message)
    const link = channel === 'mqtt' ? mqttLink : wsLink
    const sent = !!link?.send(text)
    pushLog(sent ? 'info' : 'warn', channel === 'mqtt' ? 'MQTT' : 'WebSocket',
      sent ? `重发最近状态：${message.event}（第 ${message.page} 页，沿用 id ${message.id}）` : '重发最近状态失败')
  },
}

/** 当前页（1 开始）的备注纯文本；在页码变化后同步调用，保证新页码配上新备注 */
function getNotes(page: number): string {
  const slidesStore = useSlidesStore()
  const remark = slidesStore.slides[page - 1]?.remark
  return remarkToPlainText(remark)
}

export function initPresentationBridge() {
  // 观众窗口只跟随显示，不对外发送
  if (new URLSearchParams(window.location.search).get('mode') === 'audience') return
  // 幂等：重复调用（如 HMR）不会重复注册监听
  if (inited) return
  inited = true

  const screenStore = useScreenStore()
  const slidesStore = useSlidesStore()
  const { screening } = storeToRefs(screenStore)
  const { slideIndex } = storeToRefs(slidesStore)

  session = new PresentationSession({ getNotes })
  session.pendingPageProvider = () => slidesStore.slideIndex + 1

  // 同步 watch（flush: 'sync'）：状态变更瞬间即产生事件，与翻页动作同步完成，不阻塞播放
  unwatchFns = [
    watchRef(screening, value => {
      if (!session) return
      presentationLinkState.sessionActive = value
      const message = session.handleScreeningChange(value)
      if (message) publish(message, value ? 'presentation.started' : 'presentation.ended')
    }),
    watchRef(slideIndex, () => {
      if (!session) return
      const message = session.handlePageChange(slideIndex.value + 1)
      if (message) publish(message, 'slide.changed')
    }),
  ]

  presentationLinkState.inited = true
  pushLog('info', '系统', '放映联动桥接已初始化（主控窗口）')
  applyConfig(loadPresentationLinkConfig())
}

// 统一的同步 watch 包装（集中声明 flush: 'sync'）
function watchRef<T>(source: Ref<T>, cb: (value: T) => void) {
  return watch(source, value => cb(value), { flush: 'sync' })
}

export function destroyPresentationBridge() {
  if (!inited) return
  unwatchFns.forEach(unwatch => unwatch())
  unwatchFns = []
  session?.reset()
  session = null
  mqttLink?.destroy()
  wsLink?.destroy()
  mqttLink = null
  wsLink = null
  runtimeConfig = null
  presentationLinkState.inited = false
  presentationLinkState.sessionActive = false
  presentationLinkState.mqttStatus = 'disabled'
  presentationLinkState.wsStatus = 'disabled'
  inited = false
}

/** 同一次真实事件：一个 id、一份数据，向每个已连接通道各发送一次 */
function publish(message: PresentationEventMessage, label: string) {
  try {
    const text = JSON.stringify(message)
    const mqttSent = !!mqttLink?.send(text)
    const wsSent = !!wsLink?.send(text)

    const entry: RecentEventEntry = {
      id: message.id,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      event: message.event,
      page: message.page,
      notes: message.notes,
      mqtt: mqttSent,
      ws: wsSent,
      text,
    }
    presentationLinkState.recentEvents.unshift(entry)
    if (presentationLinkState.recentEvents.length > RECENT_EVENT_LIMIT) {
      presentationLinkState.recentEvents.splice(RECENT_EVENT_LIMIT)
    }

    const targets: string[] = []
    if (runtimeConfig?.mqtt.enabled) targets.push(mqttSent ? 'MQTT' : 'MQTT(未连接，已丢弃)')
    if (runtimeConfig?.ws.enabled) targets.push(wsSent ? 'WebSocket' : 'WebSocket(未连接，已丢弃)')
    pushLog(mqttSent || wsSent ? 'info' : 'warn', '系统',
      `${label}：第 ${message.page} 页 → ${targets.join('、') || '（无启用通道，已跳过）'}，id=${message.id}`)
  }
  catch (error) {
    // 任何异常都不允许影响放映
    pushLog('error', '系统', `事件发送异常：${(error as Error)?.message || error}`)
  }
}

/** 应用新配置：保存到 localStorage，并按需重建通道连接 */
export function applyConfig(config: PresentationLinkConfig) {
  runtimeConfig = clonePresentationLinkConfig(config)
  savePresentationLinkConfig(config)

  if (!mqttLink) mqttLink = new MqttLink(channelHooks)
  if (!wsLink) wsLink = new WsLink(channelHooks)

  mqttLink.apply(config.mqtt, { password: runtimeConfig.mqtt.password })
  wsLink.apply(config.ws)
  pushLog('info', '系统', '配置已保存并应用')
}

/** 面板中主动连接某通道（使用当前内存中的配置） */
export function connectChannel(channel: ChannelId) {
  if (!runtimeConfig) return
  if (channel === 'mqtt') {
    runtimeConfig.mqtt.enabled = true
    savePresentationLinkConfig(runtimeConfig)
    mqttLink?.apply(runtimeConfig.mqtt)
  }
  else {
    runtimeConfig.ws.enabled = true
    savePresentationLinkConfig(runtimeConfig)
    wsLink?.apply(runtimeConfig.ws)
  }
}

/** 面板中主动断开某通道 */
export function disconnectChannel(channel: ChannelId) {
  if (!runtimeConfig) return
  if (channel === 'mqtt') {
    runtimeConfig.mqtt.enabled = false
    savePresentationLinkConfig(runtimeConfig)
    mqttLink?.disconnect()
  }
  else {
    runtimeConfig.ws.enabled = false
    savePresentationLinkConfig(runtimeConfig)
    wsLink?.disconnect()
  }
  pushLog('info', channel === 'mqtt' ? 'MQTT' : 'WebSocket', '已手动断开')
}

/** 连接测试（使用面板当前草稿配置，建立临时连接，不影响正式通道） */
export function testChannel(
  channel: ChannelId,
  config: PresentationLinkConfig,
): Promise<ConnectionTestResult> {
  if (channel === 'mqtt') {
    return testMqttConnection(config.mqtt, { password: config.mqtt.password })
  }
  return testWsConnection(config.ws)
}

export function getChannelStatusLabel(channel: ChannelId): string {
  const status = channel === 'mqtt' ? presentationLinkState.mqttStatus : presentationLinkState.wsStatus
  return CHANNEL_STATUS_LABELS[status]
}

export function getSessionPresentation(): PresentationSession | null {
  return session
}

/** 供设置面板初始化草稿：优先返回运行期配置（含本次会话内输入的密码），否则读持久化配置 */
export function getRuntimePresentationLinkConfig(): PresentationLinkConfig {
  return clonePresentationLinkConfig(runtimeConfig || loadPresentationLinkConfig())
}
