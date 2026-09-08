/**
 * 双 PPT 合成图 MQTT 发布器。
 * 只保留尚未发送的最新 revision，避免页面连续切换时让板端排队下载过时图片。
 */
import mqtt from 'mqtt'

export function createMonitorMqttPublisher({ topic, log = () => {} }) {
  let client = null
  let configKey = ''
  let connected = false
  let pending = null
  let timer = null
  let lastPublishedRevision = null
  let lastError = null

  function stop() {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
    connected = false
    if (client) client.end(true)
    client = null
  }

  function applyConfig(config) {
    const mqttConfig = config?.mqtt
    const nextKey = JSON.stringify({ enabled: !!mqttConfig?.enabled, url: mqttConfig?.url || '', username: mqttConfig?.username || '', password: mqttConfig?.password || '', qos: mqttConfig?.qos })
    if (nextKey === configKey) return
    stop()
    configKey = nextKey
    if (!mqttConfig?.enabled || !/^wss?:\/\//i.test(mqttConfig.url || '')) return
    try {
      client = mqtt.connect(mqttConfig.url, {
        clientId: `pptist-monitor-${Math.random().toString(36).slice(2, 10)}`,
        username: mqttConfig.username || undefined,
        password: mqttConfig.password || undefined,
        reconnectPeriod: 1500,
        connectTimeout: 5000,
        clean: true,
      })
      client.on('connect', () => { connected = true; lastError = null; schedule(0) })
      client.on('close', () => { connected = false })
      client.on('error', error => { lastError = error.message })
    }
    catch (error) { lastError = error.message }
  }

  function schedule(delay = 80) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, delay)
  }

  function flush() {
    timer = null
    if (!pending || !client || !connected) return
    const message = pending
    pending = null
    client.publish(topic, JSON.stringify(message), { qos: 1, retain: true }, error => {
      if (error) { lastError = error.message; pending = message; return }
      lastPublishedRevision = message.revision
      lastError = null
      if (pending) schedule(30)
    })
  }

  function publish(message) {
    pending = message
    schedule()
  }

  function status() {
    return { topic, connected, lastPublishedRevision, lastError, queuedRevision: pending?.revision || null }
  }

  return { applyConfig, publish, status, stop }
}
