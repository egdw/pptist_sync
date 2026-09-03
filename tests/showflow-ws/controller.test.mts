/**
 * ShowFlowController 行为自测：
 *   npm run test:showflow:controller
 *
 * 覆盖验收场景：
 * - 场景 8：TRANSITIONING 中连续按 → 只执行一次
 * - 场景 9：同 commandId 重发（重试沿用同一 id，客户端可幂等）
 * - 场景 10：1.5s 无 ACK 自动重试；strict 下耗尽重试不放行，手动兜底解锁
 * - 场景 11：← 恢复上一 Step 完整快照（从 Step 0 折叠计算，与方向无关）
 * - 事件型 Step：无需导航、立即完成、afterAck 触发
 *
 * 注意：strict 模式下 next()/previous() 会阻塞到 ACK（或重试耗尽）才 resolve，
 * 测试须并发发送 ACK，不能直接 await。
 */
import { ShowFlowController } from '../../src/show-flow/controller.ts'

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗ FAIL:', name) } }
const wait = ms => new Promise(r => setTimeout(r, ms))

const steps = [
  { id: 'step-1', order: 1, main: { action: 'goto', pageId: 'a1' } },
  { id: 'step-2', order: 2, secondary: { action: 'goto', pageId: 'f1' } },
  { id: 'step-3', order: 3, main: { action: 'goto', pageId: 'a2' }, secondary: { action: 'goto', pageId: 'f2' }, tablet: { scene: 'scene06' } },
  { id: 'step-4', order: 4, mqtt: { topic: 'show/event/x', payload: 1 } },
]

const buildHarness = (overrides = {}) => {
  const mainCalls = []
  const sentMessages = []
  let notices = []
  let phase = 'READY'
  const controller = new ShowFlowController(
    () => ({
      main: { gotoById: async (pageId, cmd) => { mainCalls.push({ pageId, cmd }) } },
      secondary: { gotoById: async (pageId, cmd) => { sentMessages.push({ type: 'NAVIGATE', commandId: cmd, pageId }) } },
    }),
    { sendToRole: (role, msg) => sentMessages.push({ ...msg, role }) },
    {
      onPhaseChange: p => { phase = p },
      onStepChange: () => {},
      onNotice: (text, type) => notices.push({ text, type }),
      onEventAction: (stepId, timing) => notices.push({ text: `event:${stepId}:${timing}` }),
    },
    () => ({ enabled: true, confirmationEnabled: true, confirmationMode: 'strict', stepCount: steps.length, ...overrides }),
  )
  controller.registerStepsAccessor(i => steps[i])
  const ackLast = pageId => {
    const nav = [...sentMessages].reverse().find(m => m.type === 'NAVIGATE' && m.pageId === pageId)
    if (nav) controller.handleWsMessage({ type: 'ACK', commandId: nav.commandId, pageId, rendered: true })
    return nav?.commandId
  }
  return { controller, mainCalls, sentMessages, notices: () => notices, getPhase: () => phase, resetNotices: () => { notices = [] }, ackLast }
}

const main = async () => {
  // —— 启动 + keep 继承 ——
  const h = buildHarness()
  await h.controller.start(0)
  ok(h.controller.snapshot?.mainPageId === 'a1' && h.controller.snapshot?.secondaryPageId === null, 'start: Step1 落位 main=a1')
  ok(h.controller.ready, 'start: 无副屏目标 -> 直接 READY')

  // —— 场景 8：TRANSITIONING 中连击被忽略 ——
  const p1 = h.controller.next() // Step2: 副屏 f1，阻塞等待 ACK
  await wait(50)
  const navF1 = h.sentMessages.filter(m => m.type === 'NAVIGATE' && m.pageId === 'f1')
  ok(navF1.length === 1, '场景8: f1 只收到一次 NAVIGATE')
  ok((await h.controller.next()) === false, '场景8: TRANSITIONING 中第二次 → 被忽略')
  h.ackLast('f1')
  ok((await p1) === true, '场景8: 第一次 → 在 ACK 后正常完成')
  ok(h.controller.ready, 'ACK 后回到 READY')

  // keep 继承：Step2 仅副屏 goto，主屏保持 a1
  ok(h.controller.snapshot?.mainPageId === 'a1' && h.controller.snapshot?.secondaryPageId === 'f1', 'keep 继承: Step2 快照 main=a1, secondary=f1')
  // 幂等：重复 ACK 不产生副作用
  h.controller.handleWsMessage({ type: 'ACK', commandId: navF1[0].commandId, rendered: true })
  ok(h.controller.ready && h.controller.snapshot?.secondaryPageId === 'f1', '重复 ACK 幂等处理')

  // —— Step3 主副同步 + tablet ——
  await wait(220) // 越过防连击 debounce
  const p3 = h.controller.next() // Step3: 主 a2 + 副 f2
  await wait(50)
  ok(h.mainCalls.at(-1)?.pageId === 'a2', 'Step3: 主屏 gotoById(a2) 已执行')
  h.ackLast('f2')
  ok((await p3) === true, 'Step3: ACK 后完成')
  ok(h.controller.snapshot?.mainPageId === 'a2' && h.controller.snapshot?.secondaryPageId === 'f2' && h.controller.snapshot?.tabletScene === 'scene06', 'Step3: 主副同步切换 + tablet scene 快照')

  // —— 事件型 Step ——
  h.resetNotices()
  await wait(220) // 越过防连击 debounce
  const navCountBefore = h.sentMessages.filter(m => m.type === 'NAVIGATE').length
  ok((await h.controller.next()) === true, '事件型 Step 立即完成')
  ok(h.sentMessages.filter(m => m.type === 'NAVIGATE').length === navCountBefore, '事件型 Step 不触发 NAVIGATE')
  ok(h.notices().some(n => n.text === 'event:step-4:afterAck'), '事件型 Step 以 afterAck 时机触发')

  // —— 场景 11：← 恢复上一 Step 完整快照（方向无关的折叠计算） ——
  h.mainCalls.length = 0
  await wait(220) // 越过防连击 debounce
  const pp1 = h.controller.previous() // → Step3，副屏 f2 需 ACK
  await wait(50)
  h.ackLast('f2')
  await pp1
  ok(h.controller.snapshot?.mainPageId === 'a2' && h.controller.snapshot?.secondaryPageId === 'f2', '场景11: ← 回到 Step3 快照')

  await wait(220) // 越过防连击 debounce
  const pp2 = h.controller.previous() // → Step2，副屏 f1 需 ACK
  await wait(50)
  h.ackLast('f1')
  await pp2
  // 关键：Step2 的完整状态是 main=a1（Step1 的 goto 继承）+ f1，
  // 后退时不能因为刚离开 Step3 就把 main 错误地恢复/保持为 a2
  ok(h.controller.snapshot?.mainPageId === 'a1' && h.controller.snapshot?.secondaryPageId === 'f1', '场景11: ← 回到 Step2 完整快照（main 折叠自 Step1，而非继承 Step3）')
  ok(h.mainCalls.at(-1)?.pageId === 'a1', '场景11: 主屏被直接恢复到 a1（整体快照恢复，非各屏 previous）')

  // —— 场景 9/10：超时重试用同一 commandId；strict 耗尽不放行 ——
  const h2 = buildHarness()
  await h2.controller.start(0)
  h2.controller.next() // Step2: 副屏 f1, 等待 ACK
  await wait(1700) // 1.5s 超时 + 第一次重发
  const f1Msgs = h2.sentMessages.filter(m => m.type === 'NAVIGATE' && m.pageId === 'f1')
  ok(f1Msgs.length >= 2, '场景10: 1.5s 未 ACK 自动重发')
  ok(new Set(f1Msgs.map(m => m.commandId)).size === 1, '场景9: 重发沿用同一 commandId（客户端可幂等）')
  ok(h2.getPhase() === 'TRANSITIONING', '场景10: strict 模式未确认不放行（仍 TRANSITIONING）')
  ok((await h2.controller.next()) === false, '场景10: 未确认期间 next 被拒绝')
  h2.controller.forceComplete()
  ok(h2.controller.ready, '兜底: 强制完成解锁 READY')

  // 完整耗尽路径：不 ACK，等 3 次重试后 strict 保持 TRANSITIONING，跳过副屏解锁
  const h3 = buildHarness()
  await h3.controller.start(0)
  const p3h = h3.controller.next()
  const done = await p3h
  ok(done === true, 'strict 重试耗尽后 next 落位（返回 true 但保持异常态）')
  ok(h3.getPhase() === 'TRANSITIONING', 'strict 重试耗尽后保持 TRANSITIONING（不放行）')
  const retryCount = h3.sentMessages.filter(m => m.type === 'NAVIGATE' && m.pageId === 'f1').length
  ok(retryCount === 4, `场景9/10: 初次 + 3 次重试共 4 次同一 commandId（实际 ${retryCount}）`)
  h3.controller.skipSecondary()
  ok(h3.controller.ready, '兜底: 跳过副屏解锁')

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
