/**
 * ShowFlow WebSocket 服务器（挂在 pptist-server 的 http server 上）。
 *
 * 职责（刻意保持极薄）：
 * - 角色注册：HELLO 声明 role（controller / secondary / tablet / console），一个会话只允许一个 main/controller
 * - 消息路由：controller ↔ 各角色客户端 双向转发（按 role 路由）
 * - 心跳转发：controller 发 PING 时，服务器代每个在线角色回 PONG，controller 据此判在线
 *
 * 所有业务语义（NAVIGATE/ACK/SYNC_STATE/幂等/重试）都在 Controller 与播放端实现，
 * 服务器不解析业务字段。
 */
import { WebSocketServer } from 'ws'

const ALLOWED_ROLES = new Set(['controller', 'main', 'secondary', 'tablet', 'console'])
const SINGLE_INSTANCE_ROLES = new Set(['controller', 'main'])

export function attachShowFlowWs(server, log = () => {}) {
  const wss = new WebSocketServer({ noServer: true })
  /** ws -> { role } */
  const clients = new Map()
  const runtime = { stepId: null, mainPageId: null, secondaryPageId: null, seq: null, updatedAt: null }

  const byRole = role => {
    const found = []
    for (const [ws, info] of clients) {
      if (info.role === role && ws.readyState === ws.OPEN) found.push(ws)
    }
    return found
  }

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  /** 探测旧连接是否存活：协议级 ping（浏览器自动回 pong），超时视为僵尸 */
  function probeAlive(ws, timeoutMs = 1000) {
    return new Promise(resolve => {
      let settled = false
      const onPong = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve(true)
      }
      const cleanup = () => {
        ws.removeListener('pong', onPong)
        clearTimeout(timer)
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve(false)
      }, timeoutMs)
      ws.once('pong', onPong)
      try { ws.ping() } catch { cleanup(); resolve(false) }
    })
  }

  wss.on('connection', (ws, req) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`
    clients.set(ws, { role: null, connectedAt: Date.now(), lastSeen: Date.now(), lastAck: null, lastHeartbeat: null, meta: {} })
    // 注意：不打印每次"连接"日志 —— 未获准角色的客户端会按退避间隔反复重连，
    // 逐连接打印会刷屏；注册与断开日志已足够定位问题

    ws.on('message', async raw => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      }
      catch {
        send(ws, { type: 'ERROR', code: 'BAD_JSON', message: '消息不是合法 JSON' })
        return
      }
      const tracked = clients.get(ws)
      if (tracked) {
        tracked.lastSeen = Date.now()
        if (msg.type === 'PING' || msg.type === 'PONG') tracked.lastHeartbeat = tracked.lastSeen
        if (msg.type === 'ACK') tracked.lastAck = tracked.lastSeen
      }

      // —— 注册 ——
      if (msg.type === 'HELLO') {
        const role = msg.role
        if (!ALLOWED_ROLES.has(role)) {
          send(ws, { type: 'ERROR', code: 'BAD_ROLE', message: `未知角色: ${role}` })
          ws.close()
          return
        }
        if (SINGLE_INSTANCE_ROLES.has(role)) {
          const existing = byRole(role)[0]
          if (existing && existing !== ws) {
            // force=true：用户显式点击「接管控制台」，直接替换占用中的旧控制台；
            // 否则仅当旧连接为僵尸（协议 ping 1s 无 pong）时接管，存活则拒绝
            const alive = msg.force === true ? false : await probeAlive(existing)
            if (alive) {
              send(ws, { type: 'ERROR', code: 'ROLE_TAKEN', message: `${role} 角色已由其他窗口占用` })
              ws.close()
              return
            }
            log(`[showflow-ws] ${msg.force === true ? '新控制台强制接管' : '检测到僵尸连接，自动接管'}（${role}）`)
            clients.delete(existing)
            // 先发通知再关闭：terminate 会立即销毁 socket，排队的 ERROR 帧发不出去
            send(existing, { type: 'ERROR', code: 'CONTROLLER_REPLACED', message: '控制台已被其他窗口接管' })
            existing.close(1000, 'replaced')
            setTimeout(() => {
              try { existing.terminate() } catch { /* 已死 */ }
            }, 500).unref()
          }
        }
        clients.set(ws, { ...clients.get(ws), role, meta: msg.meta || {} })
        send(ws, { type: 'HELLO_ACK', role, meta: msg.meta })
        // 通知 controller 有新角色上线（controller 收到后回发 SYNC_STATE）
        for (const c of byRole('controller')) send(c, { type: 'HELLO', role })
        log(`[showflow-ws] ${peer} 注册为 ${role}`)
        return
      }

      const info = clients.get(ws)
      if (!info?.role) {
        send(ws, { type: 'ERROR', code: 'NOT_REGISTERED', message: '请先发送 HELLO 注册角色' })
        return
      }

      // 只镜像 Controller 已经决定的快照，供 Studio 状态页只读展示；不参与路由和业务决策。
      if (info.role === 'controller' && msg.type === 'SYNC_STATE' && msg.state) {
        Object.assign(runtime, { stepId: msg.state.stepId || null, mainPageId: msg.state.mainPageId || null, secondaryPageId: msg.state.secondaryPageId || null, seq: msg.state.seq ?? null, updatedAt: Date.now() })
      }

      // —— 心跳 ——
      if (msg.type === 'PING') {
        // 各角色 PING：回 PONG（带自身角色）
        if (info.role !== 'controller') send(ws, { type: 'PONG', role: info.role })
        // controller PING：代每个在线远端角色回 PONG，controller 据此维护在线表
        if (info.role === 'controller') {
          const roles = new Set()
          for (const [, other] of clients) {
            if (other.role && other.role !== 'controller' && other.role !== 'console') roles.add(other.role)
          }
          for (const role of roles) send(ws, { type: 'PONG', role })
        }
        return
      }

      // —— 业务消息路由 ——
      if (info.role === 'controller') {
        // controller -> 指定 role（或广播给所有非 controller 角色）
        const targets = msg.role && msg.role !== 'controller'
          ? byRole(msg.role)
          : [...new Set([...byRole('main'), ...byRole('secondary'), ...byRole('tablet'), ...byRole('console')])]
        for (const t of targets) send(t, msg)
      }
      else {
        // 角色客户端 -> controller
        for (const c of byRole('controller')) send(c, { ...msg, role: info.role })
      }
    })

    ws.on('close', () => {
      const info = clients.get(ws)
      clients.delete(ws)
      if (info?.role) {
        log(`[showflow-ws] ${info.role}(${peer}) 断开`)
        for (const c of byRole('controller')) send(c, { type: 'ERROR', code: 'PEER_OFFLINE', message: info.role })
      }
    })
    ws.on('error', () => ws.close())
  })

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (pathname === '/showflow') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
    }
    // 其他路径不处理，交由其它 upgrade 监听者（如有）
  })

  const getStatus = () => {
    const now = Date.now()
    const roles = {}
    for (const [, info] of clients) {
      if (!info.role) continue
      const item = roles[info.role] || { role: info.role, connections: 0, online: true, connectedAt: info.connectedAt, lastSeen: null, lastAck: null, lastHeartbeat: null, meta: [] }
      item.connections++
      item.connectedAt = Math.min(item.connectedAt || info.connectedAt, info.connectedAt)
      item.lastSeen = Math.max(item.lastSeen || 0, info.lastSeen || 0)
      item.lastAck = Math.max(item.lastAck || 0, info.lastAck || 0) || null
      item.lastHeartbeat = Math.max(item.lastHeartbeat || 0, info.lastHeartbeat || 0) || null
      item.meta.push(info.meta || {})
      roles[info.role] = item
    }
    return { totalConnections: clients.size, checkedAt: now, roles, runtime: { ...runtime } }
  }
  return { wss, getStatus }
}
