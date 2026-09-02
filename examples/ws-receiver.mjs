/* eslint-env node */
/* eslint-disable no-console */
/**
 * 最小本地 WebSocket 接收示例 —— 用于查看 PPTist「放映联动」实际发出的消息
 *
 * 使用：
 *   1. npm install ws          （本示例仅在服务端需要 ws 依赖）
 *   2. node examples/ws-receiver.mjs [端口]   （默认 9001）
 *   3. 在 PPTist「放映联动」设置中，启用 WebSocket 通道，
 *      服务地址填 ws://127.0.0.1:9001，保存后开始放映
 *
 * 收到的消息为四字段 JSON 文本：
 *   { "event": "slide.changed", "page": 5, "id": "V1StGXR8_Z5jdHi6", "notes": "当前页备注" }
 * 提示：同一事件可能因 MQTT QoS 重传或双通道同时启用而重复到达，接收端应按 id 去重。
 */
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2]) || 9001
const wss = new WebSocketServer({ port, host: '0.0.0.0' })

wss.on('listening', () => {
  console.log(`[ws-receiver] 正在监听 ws://0.0.0.0:${port}，等待 PPTist 连接 ...`)
})

wss.on('connection', socket => {
  console.log('[ws-receiver] PPTist 已连接')
  socket.on('message', data => {
    const text = data.toString()
    try {
      const { event, page, id, notes } = JSON.parse(text)
      console.log(`[收到] event=${event} page=${page} id=${id}\n       notes=${JSON.stringify(notes)}`)
    }
    catch {
      console.log(`[收到] 非JSON文本: ${text}`)
    }
  })
})

wss.on('error', error => {
  console.error('[ws-receiver] 服务端错误：', error.message)
  process.exit(1)
})
