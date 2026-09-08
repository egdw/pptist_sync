/**
 * SecondaryShowFlowClient（PPTist B 副屏协议客户端）行为自测：
 *   npm run test:showflow:secondary
 *
 * 覆盖：
 * - 场景 9：同一 commandId 重发 3 次，客户端只实际执行一次（但每次都补 ACK，供重试聚合）
 * - ACK 时机：navigate() Promise resolve（= 切页 + 渲染）之后才回 ACK
 * - SYNC_STATE：捕获 sessionId 并按快照恢复
 * - PING → PONG
 * - navigate 失败：回 ERROR + 释放幂等记录（允许重试真正执行）
 * - controlled 状态：受控/交还本机控制
 */
import { SecondaryShowFlowClient } from '../../src/show-flow/secondaryClient.ts'
import type { ShowFlowMessage } from '../../src/show-flow/websocket/protocol.ts'

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗ FAIL:', name) } }
const wait = ms => new Promise(r => setTimeout(r, ms))

const buildHarness = (navigateImpl?: (pageId: string) => Promise<void>) => {
  const sent: ShowFlowMessage[] = []
  const navCalls: string[] = []
  let controlledLog: boolean[] = []
  const client = new SecondaryShowFlowClient({
    send: msg => sent.push(msg),
    navigate: pageId => {
      navCalls.push(pageId)
      return navigateImpl ? navigateImpl(pageId) : Promise.resolve()
    },
    onControlledChange: v => controlledLog.push(v),
  })
  return { client, sent, navCalls, controlledLog: () => controlledLog }
}

const main = async () => {
  // —— NAVIGATE：渲染后 ACK ——
  const h = buildHarness()
  h.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-107', pageId: 'slide-b06' })
  await wait(30)
  ok(h.navCalls.length === 1 && h.navCalls[0] === 'slide-b06', 'NAVIGATE 触发一次导航')
  const ack = h.sent.find(m => m.type === 'ACK')
  ok(ack?.commandId === 'cmd-107' && ack?.pageId === 'slide-b06' && ack?.rendered === true, '渲染完成后回 ACK (rendered: true)')
  ok(h.controlledLog().includes(true), '收到 NAVIGATE 后进入受控态')

  // —— 场景 9：同 commandId 重发 3 次 ——
  const h2 = buildHarness()
  h2.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-26', pageId: 'f1' })
  await wait(10)
  h2.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-26', pageId: 'f1' })
  h2.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-26', pageId: 'f1' })
  await wait(20)
  ok(h2.navCalls.filter(p => p === 'f1').length === 1, '场景9: 重发 3 次只实际执行 1 次导航')
  const acks = h2.sent.filter(m => m.type === 'ACK')
  ok(acks.length === 3, `场景9: 每次重发都补 ACK（实际 ${acks.length}）`)
  ok(acks.every(m => m.commandId === 'cmd-26'), '场景9: 补发 ACK 沿用同一 commandId')

  // —— 幂等记录有界，淘汰后允许重新执行 ——
  for (let i = 0; i < 40; i++) {
    h2.client.handleMessage({ type: 'NAVIGATE', commandId: `cmd-gen-${i}`, pageId: `p${i}` })
    await wait(1)
  }
  h2.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-26', pageId: 'f1' })
  await wait(10)
  ok(h2.navCalls.filter(p => p === 'f1').length === 2, '幂等记录淘汰后，旧 commandId 再次到达会重新执行')

  // —— SYNC_STATE：恢复状态 ——
  const h3 = buildHarness()
  h3.client.handleMessage({ type: 'SYNC_STATE', sessionId: 'sess-abc', state: { stepId: 'step-26', seq: 26, mainPageId: 'a07', secondaryPageId: 'flow05', tabletScene: 'vehicle-link' } })
  await wait(20)
  ok(h3.navCalls.includes('flow05'), 'SYNC_STATE 按快照恢复副屏页面')
  ok(h3.client.sessionId === 'sess-abc', 'SYNC_STATE 捕获 sessionId')

  // —— PING → PONG ——
  h3.sent.length = 0
  h3.client.handleMessage({ type: 'PING' })
  ok(h3.sent.some(m => m.type === 'PONG'), 'PING 回 PONG')

  // —— navigate 失败：ERROR + 释放幂等记录 ——
  let failFirst = true
  const h4 = buildHarness(pageId => failFirst
    ? Promise.reject(new Error('页面不存在'))
    : Promise.resolve())
  h4.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-x', pageId: 'gone' })
  await wait(20)
  ok(h4.sent.some(m => m.type === 'ERROR' && m.code === 'NAVIGATE_FAILED' && m.commandId === 'cmd-x'), '导航失败回 ERROR')
  failFirst = false
  h4.client.handleMessage({ type: 'NAVIGATE', commandId: 'cmd-x', pageId: 'gone' })
  await wait(20)
  ok(h4.navCalls.filter(p => p === 'gone').length === 2, '失败的 commandId 释放幂等记录，重试可重新执行')

  // —— reset 交还本机控制 ——
  h.client.reset()
  ok(h.controlledLog().at(-1) === false, 'reset() 后交还本机控制权（WS 断线兜底）')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
