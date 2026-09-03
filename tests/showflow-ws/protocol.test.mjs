/**
 * ShowFlow WS 协议端到端自测：
 * 1. HELLO 注册 + 角色拒绝（重复 controller）
 * 2. controller -> secondary NAVIGATE 路由
 * 3. secondary ACK 回路由
 * 4. 心跳 PING -> PONG（带角色）
 * 5. 幂等：同 commandId 重复 NAVIGATE 由客户端去重（此处仅验证路由层转发）
 * 6. 副屏重连 -> controller 收到 HELLO 通知（触发 SYNC_STATE）
 */
import WebSocket from 'ws'

const URL = 'ws://127.0.0.1:8799/showflow'
const log = (...a) => console.log('[test]', ...a)
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; log('✓', name) } else { fail++; log('✗ FAIL:', name) } }

const wait = ms => new Promise(r => setTimeout(r, ms))

class Client {
  constructor(name) {
    this.name = name
    this.messages = []
    this.ws = new WebSocket(URL)
    this.opened = new Promise(resolve => this.ws.on('open', resolve))
    this.ws.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      this.messages.push(msg)
    })
  }
  send(msg) { this.ws.send(JSON.stringify(msg)) }
  async next(pred, timeout = 2000) {
    const start = Date.now()
    let idx = this.messages.length
    while (Date.now() - start < timeout) {
      const found = this.messages.slice(idx).find(pred)
      if (found) return found
      await wait(30)
    }
    return null
  }
  close() { this.ws.close() }
}

const main = async () => {
  // 1. controller 注册
  const controller = new Client('controller')
  await controller.opened
  controller.send({ type: 'HELLO', role: 'controller' })
  const helloAck = await controller.next(m => m.type === 'HELLO_ACK')
  ok(helloAck?.role === 'controller', 'controller HELLO 注册成功')

  // 2. 重复 controller 被拒
  const controller2 = new Client('controller-2')
  await controller2.opened
  controller2.send({ type: 'HELLO', role: 'controller' })
  const rejected = await controller2.next(m => m.type === 'ERROR')
  ok(rejected?.code === 'ROLE_TAKEN', '重复 controller 被拒绝 (ROLE_TAKEN)')
  controller2.close()

  // 3. secondary 注册 -> controller 收到通知
  const secondary = new Client('secondary')
  await secondary.opened
  secondary.send({ type: 'HELLO', role: 'secondary', meta: { screen: 'reveal-md' } })
  const secAck = await secondary.next(m => m.type === 'HELLO_ACK')
  ok(secAck?.role === 'secondary', 'secondary 注册成功')
  // 通知可能在本断言开始前就已到达，扫描全部历史
  await wait(300)
  const ctrlNotified = controller.messages.find(m => m.type === 'HELLO' && m.role === 'secondary')
  ok(!!ctrlNotified, 'controller 收到 secondary 上线通知（可触发 SYNC_STATE）')

  // 4. NAVIGATE 路由：controller -> secondary
  controller.send({ type: 'NAVIGATE', commandId: 'cmd-107', stepId: 'step-26', pageId: 'vehicle-link', role: 'secondary' })
  const nav = await secondary.next(m => m.type === 'NAVIGATE' && m.commandId === 'cmd-107')
  ok(nav?.pageId === 'vehicle-link', 'NAVIGATE 路由到 secondary')

  // 5. ACK 路由：secondary -> controller
  secondary.send({ type: 'ACK', commandId: 'cmd-107', stepId: 'step-26', pageId: 'vehicle-link', rendered: true })
  const ack = await controller.next(m => m.type === 'ACK' && m.commandId === 'cmd-107' && m.role === 'secondary')
  ok(ack?.rendered === true, 'ACK 带角色路由回 controller')

  // 6. 心跳：controller PING -> PONG(secondary)
  controller.send({ type: 'PING', role: 'controller' })
  const pong = await controller.next(m => m.type === 'PONG' && m.role === 'secondary')
  ok(!!pong, 'controller PING 得到带角色的 PONG')
  secondary.send({ type: 'PING' })
  const pong2 = await secondary.next(m => m.type === 'PONG')
  ok(pong2?.role === 'secondary', 'secondary PING 得到自身角色 PONG')

  // 7. 副屏断线 -> controller 收到 PEER_OFFLINE
  secondary.close()
  const offline = await controller.next(m => m.type === 'ERROR' && m.code === 'PEER_OFFLINE')
  ok(offline?.message === 'secondary', '副屏断线通知 controller (PEER_OFFLINE)')

  // 8. 副屏重连 -> controller 再次收到 HELLO（控制器据此 resyncAll）
  const secondary2 = new Client('secondary-2')
  await secondary2.opened
  secondary2.send({ type: 'HELLO', role: 'secondary' })
  const rejoin = await controller.next(m => m.type === 'HELLO' && m.role === 'secondary')
  ok(!!rejoin, '副屏重连后 controller 再次收到上线通知')

  // 9. SYNC_STATE 路由
  controller.send({ type: 'SYNC_STATE', sessionId: 'sess-abc', role: 'secondary', state: { stepId: 'step-26', seq: 26, mainPageId: 'a07', secondaryPageId: 'flow05', tabletScene: 'vehicle-link' } })
  const sync = await secondary2.next(m => m.type === 'SYNC_STATE')
  ok(sync?.state?.stepId === 'step-26' && sync?.sessionId === 'sess-abc', 'SYNC_STATE 完整快照下发')

  // 10. 未注册客户端被拒
  const anon = new Client('anon')
  await anon.opened
  anon.send({ type: 'NAVIGATE', commandId: 'x' })
  const anonErr = await anon.next(m => m.type === 'ERROR' && m.code === 'NOT_REGISTERED')
  ok(!!anonErr, '未注册客户端发送业务消息被拒 (NOT_REGISTERED)')

  controller.close()
  secondary2.close()
  anon.close()
  await wait(200)
  log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
