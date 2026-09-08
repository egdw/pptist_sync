/**
 * “放映联动”配置：持久化到 localStorage
 *
 * 密码默认不落盘（不勾选“记住凭据”时仅保存在当前页面内存中）；
 * 勾选后随配置明文保存在本机 localStorage，界面与日志均不回显、不输出密码。
 */

export const PRESENTATION_LINK_STORAGE_KEY = 'PPTIST_PRESENTATION_LINK'

export interface MqttLinkConfig {
  enabled: boolean
  /** MQTT over WebSocket 地址，仅支持 ws:// 或 wss://（浏览器无法直连 mqtt:// 或 TCP 1883） */
  url: string
  username: string
  password: string
  /** 为空时自动生成（base-随机后缀），避免多个浏览器实例相互踢下线 */
  clientId: string
  topic: string
  qos: 0 | 1 | 2
  retain: boolean
}

export interface WsLinkConfig {
  enabled: boolean
  /** ws:// 或 wss:// 地址 */
  url: string
  /** 可选鉴权参数，以 ?token=xxx 追加到地址（浏览器 WebSocket 不支持自定义请求头） */
  token: string
}

export interface PresentationLinkConfig {
  mqtt: MqttLinkConfig
  ws: WsLinkConfig
  /** 是否记住凭据（保存后密码写入 localStorage；不勾选则刷新后需重新输入） */
  rememberCredentials: boolean
}

export const PRESENTATION_LINK_DEFAULTS: PresentationLinkConfig = {
  mqtt: {
    enabled: false,
    url: 'ws://',
    username: '',
    password: '',
    clientId: '',
    topic: 'presentation/events',
    qos: 1,
    retain: false,
  },
  ws: {
    enabled: false,
    url: 'ws://',
    token: '',
  },
  rememberCredentials: false,
}

export function loadPresentationLinkConfig(): PresentationLinkConfig {
  let stored: Partial<PresentationLinkConfig> = {}
  try {
    const raw = localStorage.getItem(PRESENTATION_LINK_STORAGE_KEY)
    if (raw) stored = JSON.parse(raw) || {}
  }
  catch {
    stored = {}
  }
  return normalizePresentationLinkConfig(stored)
}

export function normalizePresentationLinkConfig(raw: Partial<PresentationLinkConfig>): PresentationLinkConfig {
  const config: PresentationLinkConfig = {
    mqtt: { ...PRESENTATION_LINK_DEFAULTS.mqtt, ...(raw.mqtt || {}) },
    ws: { ...PRESENTATION_LINK_DEFAULTS.ws, ...(raw.ws || {}) },
    rememberCredentials: !!raw.rememberCredentials,
  }
  if (!config.rememberCredentials) config.mqtt.password = ''
  if (!config.rememberCredentials) config.ws.token = ''
  if (![0, 1, 2].includes(config.mqtt.qos)) config.mqtt.qos = 1
  return config
}

export function savePresentationLinkConfig(config: PresentationLinkConfig) {
  const persist: PresentationLinkConfig = {
    ...config,
    mqtt: { ...config.mqtt },
    ws: { ...config.ws },
  }
  if (!config.rememberCredentials) {
    persist.mqtt.password = ''
    persist.ws.token = ''
  }
  localStorage.setItem(PRESENTATION_LINK_STORAGE_KEY, JSON.stringify(persist))
  void fetch('/presentation-link-api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }),
  }).catch(() => { /* 服务端不可达时保留本地缓存 */ })
}

/** 服务端为配置事实来源；localStorage 仅用于服务端暂不可用时的缓存。 */
export async function loadPresentationLinkConfigFromServer(): Promise<PresentationLinkConfig> {
  try {
    const response = await fetch('/presentation-link-api/config', { cache: 'no-store' })
    if (!response.ok) throw new Error(String(response.status))
    const data = await response.json()
    if (data?.exists && data.config) {
      const config = normalizePresentationLinkConfig({ ...data.config, rememberCredentials: true })
      localStorage.setItem(PRESENTATION_LINK_STORAGE_KEY, JSON.stringify(config))
      return config
    }
    const local = loadPresentationLinkConfig()
    await fetch('/presentation-link-api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: local }),
    })
    return local
  }
  catch {
    return loadPresentationLinkConfig()
  }
}

/** 将内存中的配置（含未记住的密码）快照下来，供本次会话内通道重连使用 */
export function clonePresentationLinkConfig(config: PresentationLinkConfig): PresentationLinkConfig {
  return JSON.parse(JSON.stringify(config)) as PresentationLinkConfig
}
