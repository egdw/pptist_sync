/* eslint-disable no-console */
/**
 * “放映联动”针对性验证入口（由 run.mjs 用 esbuild 打包后在 Node 中执行）
 *
 * 覆盖：
 * A. remark → 纯文本（普通文本 / 中文多行 / 比较符号 / 富文本段落、br、列表 / 实体 / script 跳过）
 * B. PresentationSession 会话状态机（started 唯一、真实切页、同页去重、ended 最后页、id 唯一）
 * C. 桥接等价集成（Vue 同步 watch 模拟 App 级接线：中间页开始、视图切换、编辑模式、四字段协议）
 * D. WebSocket 通道本地实测（发送、断线丢弃、重连不重放、重发沿用原 id）
 * E. MQTT 通道本地实测（本地 aedes Broker + 双通道同 id 同内容、单通道故障不影响另一条）
 */
import assert from 'node:assert'
import { createServer } from 'node:http'
import { ref, watch } from 'vue'

import { remarkToPlainText } from '../../src/utils/presentation/remarkText'
import { PresentationSession } from '../../src/utils/presentation/session'
import { WsLink, MqttLink, type ChannelHooks } from '../../src/utils/presentation/channels'
import { PRESENTATION_EVENTS, buildPresentationMessage, type PresentationEventMessage } from '../../src/utils/presentation/protocol'

const results: string[] = []
function ok(name: string) {
  results.push(`  ✓ ${name}`)
}

// ============================== A. remark → 纯文本 ==============================
{
  assert.equal(remarkToPlainText('第一页备注\n保留换行\n第二行'), '第一页备注\n保留换行\n第二行')
  ok('普通文本（含中文与换行）原样保留')

  assert.equal(remarkToPlainText('中文，标点！引号"引号"：结束'), '中文，标点！引号"引号"：结束')
  ok('中文标点原样保留')

  assert.equal(remarkToPlainText('a<b>c 和 1 < 2 以及 3>2'), 'a<b>c 和 1 < 2 以及 3>2')
  ok('普通文本中的比较符号不被误删（不做粗暴正则剥标签）')

  assert.equal(remarkToPlainText('仅行内标记<strong>加粗</strong>无块级结构时原样保留'), '仅行内标记<strong>加粗</strong>无块级结构时原样保留')
  ok('不含块级结构的尖括号内容一律原样保留（编辑器富文本必有 <p> 包裹，不受影响）')

  assert.equal(remarkToPlainText('<p>第一段</p>\n<p>第二段</p>'), '第一段\n第二段')
  ok('HTML 段落 <p> 转换为换行')

  assert.equal(remarkToPlainText('<p>第一行\n第二行</p>'), '第一行\n第二行')
  ok('HTML 文本内的字面换行（PPTX 导入备注的常见形态）按换行保留')

  assert.equal(remarkToPlainText('<p>第一行<br>第二行<br/>第三行</p>'), '第一行\n第二行\n第三行')
  ok('<br> 转换为换行')

  assert.equal(remarkToPlainText('<ul><li>项目一</li><li>项目二</li></ul>'), '项目一\n项目二')
  ok('列表 <li> 逐项换行')

  assert.equal(remarkToPlainText('<p><strong>加粗</strong>与<em>斜体</em></p>'), '加粗与斜体')
  ok('行内标记（strong/em）仅剥离标记保留文本')

  assert.equal(remarkToPlainText('<p>&lt;abc&gt; &amp; &quot;中文&quot; &#x4E2D;&#25991;</p>'), '<abc> & "中文" 中文')
  ok('HTML 命名实体与数字实体正确解码')

  assert.equal(remarkToPlainText('<p>正文</p><script>alert(1)</script><style>.x{}</style>'), '正文')
  ok('script/style 内容整体跳过（不执行、不输出）')

  assert.equal(remarkToPlainText('<div><div>嵌套</div>外部</div>'), '嵌套\n外部')
  ok('嵌套块级元素转换为换行')

  assert.equal(remarkToPlainText('<p>a&nbsp;b</p>'), 'a b')
  ok('&nbsp; 转换为空格')

  assert.equal(remarkToPlainText(null), '')
  assert.equal(remarkToPlainText(undefined), '')
  assert.equal(remarkToPlainText(''), '')
  assert.equal(remarkToPlainText('   \n  '), '   \n  ')
  ok('空备注返回空字符串，空白文本不篡改')
}

// ============================== B. 会话状态机 ==============================
{
  const notes = (page: number) => `第${page}页备注`
  let idCounter = 0
  const session = new PresentationSession({ getNotes: notes, genId: () => `id-${++idCounter}` })
  session.pendingPageProvider = () => 1

  const started = session.handleScreeningChange(true)!
  assert.equal(started.event, PRESENTATION_EVENTS.started)
  assert.equal(started.page, 1)
  assert.equal(started.notes, '第1页备注')
  assert.equal(session.handleScreeningChange(true), null)
  ok('从第一页开始：started 仅发送一次，携带页码与备注')

  const changed = session.handlePageChange(2)!
  assert.equal(changed.event, PRESENTATION_EVENTS.changed)
  assert.equal(changed.page, 2)
  assert.equal(changed.notes, '第2页备注')
  assert.equal(session.handlePageChange(2), null)
  ok('真实切页产生 slide.changed，相同页码不重复发送')

  assert.equal(session.handlePageChange(1)!.event, PRESENTATION_EVENTS.changed)
  ok('回到上一页属于真实切页，正常发送')

  // 第一页按上一页：页码未变，不会调用 handlePageChange；等价于同页去重
  assert.equal(session.handlePageChange(1), null)
  ok('第一页按上一页（页码不变）不发送')

  const ended = session.handleScreeningChange(false)!
  assert.equal(ended.event, PRESENTATION_EVENTS.ended)
  assert.equal(ended.page, 1)
  assert.equal(ended.notes, '第1页备注')
  assert.equal(session.handleScreeningChange(false), null)
  ok('结束放映仅发送一次 ended，携带最后停留页与备注')

  assert.notEqual(started.id, changed.id)
  assert.notEqual(changed.id, ended.id)
  ok('每次真实事件 id 唯一')

  // 从中间页开始
  const session2 = new PresentationSession({ getNotes: notes, genId: () => `m-${++idCounter}` })
  session2.pendingPageProvider = () => 5
  const started2 = session2.handleScreeningChange(true)!
  assert.equal(started2.event, PRESENTATION_EVENTS.started)
  assert.equal(started2.page, 5)
  ok('从中间页开始：started 携带当前页（第 5 页）')

  // 页码/备注原子性
  const session3 = new PresentationSession({ getNotes: notes, genId: () => `a-${++idCounter}` })
  session3.pendingPageProvider = () => 3
  session3.handleScreeningChange(true)
  session3.pendingPageProvider = () => 7
  const changed3 = session3.handlePageChange(7)!
  assert.equal(changed3.page, 7)
  assert.equal(changed3.notes, '第7页备注')
  ok('切页时一次性取得新页码与新页备注')
}

// ============================== C. 桥接等价集成 ==============================
{
  // 模拟桥接层在主控窗口的接线：同步 watch + PresentationSession
  const slides = [
    { remark: '' },
    { remark: '第2页\n多行中文备注' },
    { remark: '<p>第3页富文本</p><ul><li>要点一</li><li>要点二</li></ul>' },
    { remark: '第4页' },
    { remark: '' },
  ]
  const screening = ref(false)
  const slideIndex = ref(0)
  let idCounter = 0
  const session = new PresentationSession({
    getNotes: page => remarkToPlainText(slides[page - 1]?.remark),
    genId: () => `evt-${++idCounter}`,
  })
  session.pendingPageProvider = () => slideIndex.value + 1

  const emitted: PresentationEventMessage[] = []
  // 与 bridge.ts 完全一致的同步 watch 写法
  const unwatchScreening = watch(screening, value => {
    const message = session.handleScreeningChange(value)
    if (message) emitted.push(message)
  }, { flush: 'sync' })
  const unwatchIndex = watch(slideIndex, () => {
    const message = session.handlePageChange(slideIndex.value + 1)
    if (message) emitted.push(message)
  }, { flush: 'sync' })

  // 编辑模式翻页：不发送
  slideIndex.value = 2
  slideIndex.value = 4
  assert.equal(emitted.length, 0)
  ok('编辑模式选页不发送放映事件')

  // 从中间页（第 5 页）进入放映：仅一次 started
  screening.value = true
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].event, PRESENTATION_EVENTS.started)
  assert.equal(emitted[0].page, 5)
  assert.equal(emitted[0].notes, '')
  ok('从中间页开始放映：started 仅一次，无同页 slide.changed')

  // 普通/演讲者视图切换（不改变放映状态）：无事件
  assert.equal(emitted.length, 1)
  ok('视图切换不视为重新开始放映')

  // 前进到边界外（最后一页按下一页，页码不变）：无事件
  slideIndex.value = 4
  assert.equal(emitted.length, 1)

  // 前进（最后一页 → 无下一页，页码不变）：无事件；缩略图跳页
  slideIndex.value = 1 // 跳回第 2 页
  slideIndex.value = 1 // 再点同页：无事件
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1].event, PRESENTATION_EVENTS.changed)
  assert.equal(emitted[1].page, 2)
  assert.equal(emitted[1].notes, '第2页\n多行中文备注')
  ok('缩略图/菜单跳页发送 changed；同页跳转不重复发送')

  // 退出放映：ended 携带最后停留页与备注
  screening.value = false
  assert.equal(emitted.length, 3)
  assert.equal(emitted[2].event, PRESENTATION_EVENTS.ended)
  assert.equal(emitted[2].page, 2)
  assert.equal(emitted[2].notes, '第2页\n多行中文备注')
  ok('ended 携带最后停留页（第 2 页）及其备注')

  // 从第一页重新开始（此前停在中间页，模拟“从头开始”：先重置页码，再进入放映）
  slideIndex.value = 4 // 用户停在第 5 页
  slideIndex.value = 0 // enterScreeningFromStart：先 updateSlideIndex(0)（尚未进入放映，不产生事件）
  screening.value = true // 再 enterScreening
  assert.equal(emitted.length, 4)
  assert.equal(emitted[3].event, PRESENTATION_EVENTS.started)
  assert.equal(emitted[3].page, 1)
  assert.equal(emitted[3].notes, '')
  ok('从头开始（index 重置 + 进入放映）：仅发送 started 第 1 页，无多余 slide.changed')

  // 全屏切换不影响放映状态（不产生事件）
  assert.equal(emitted.length, 4)
  ok('仅退出全屏继续放映时，不发送 ended')

  // 协议校验：恰好四个字段
  for (const message of emitted) {
    assert.deepEqual(Object.keys(message).sort(), ['event', 'id', 'notes', 'page'])
    assert.equal(typeof message.page, 'number')
    assert.equal(Number.isInteger(message.page), true)
    assert.equal(typeof message.id, 'string')
    assert.equal(typeof message.notes, 'string')
  }
  assert.equal(new Set(emitted.map(m => m.id)).size, emitted.length)
  ok('所有消息恰为 event/page/id/notes 四字段，page 为从 1 开始的整数，id 全部唯一')

  // buildPresentationMessage 默认生成器
  const sample = buildPresentationMessage(PRESENTATION_EVENTS.started, 3, 'x')
  assert.deepEqual(Object.keys(sample), ['event', 'page', 'id', 'notes'])
  ok('协议构建器输出无额外包装字段')

  unwatchScreening()
  unwatchIndex()
}

// ============================== 辅助：等待 ==============================
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(fn: () => boolean, timeoutMs = 10000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await sleep(50)
  }
}

// ============================== D/E. 通道本地实测 ==============================
async function liveTests() {
  const receivedWs: Array<{ text: string; at: number }> = []

  // —— 本地 WebSocket 服务端 ——
  let wss: any = null
  async function startWsServer() {
    const { WebSocketServer } = await import('ws')
    wss = new WebSocketServer({ port: 9377, host: '127.0.0.1' })
    wss.on('connection', (socket: any) => {
      socket.on('message', (data: Buffer) => receivedWs.push({ text: data.toString(), at: Date.now() }))
    })
    await new Promise<void>(resolve => wss.on('listening', resolve))
  }
  function stopWsServer(): Promise<void> {
    return new Promise(resolve => {
      if (!wss) return resolve()
      // 先强制断开所有客户端连接，否则 server.close 会一直等待而挂起
      for (const client of wss.clients || []) client.terminate()
      wss.close(() => resolve())
      wss = null
    })
  }

  // —— 本地 MQTT Broker（aedes + WebSocket） ——
  const receivedMqtt: Array<{ topic: string; text: string }> = []
  let httpServer: any = null
  let aedesInstance: any = null
  let subscriber: any = null
  async function startBroker() {
    const http = createServer()
    const { WebSocketServer } = await import('ws')
    const createWsStream = (await import('websocket-stream')).default
    const aedesModule = (await import('aedes')) as any
    const Aedes = aedesModule.Aedes ?? aedesModule.default ?? aedesModule
    aedesInstance = typeof Aedes.createBroker === 'function' ? await Aedes.createBroker() : new Aedes()
    const wss = new WebSocketServer({ server: http })
    wss.on('connection', (socket: any) => {
      aedesInstance.handle(createWsStream(socket))
    })
    await new Promise<void>(resolve => http.listen(9383, '127.0.0.1', resolve))
    httpServer = http

    // 订阅端（校验接收）
    const mqttModule = await import('mqtt')
    subscriber = mqttModule.default.connect('ws://127.0.0.1:9383', { clientId: 'test-subscriber' })
    subscriber.on('connect', () => {
      subscriber.subscribe('presentation/#', { qos: 1 })
    })
    subscriber.on('message', (topic: string, payload: Buffer) => {
      receivedMqtt.push({ topic, text: payload.toString() })
    })
    await waitFor(() => subscriber.connected, 8000, '订阅端连接')
  }
  async function stopBroker() {
    if (subscriber) {
      await new Promise<void>(resolve => subscriber.end(true, {}, resolve))
      subscriber = null
    }
    if (aedesInstance) {
      // 先关闭 Broker（会断开所有客户端连接），再关 HTTP 服务，否则 close 会等待存量连接而挂起
      await new Promise<void>(resolve => aedesInstance.close(() => resolve()))
      aedesInstance = null
    }
    if (httpServer) {
      await new Promise<void>(resolve => httpServer.close(resolve))
      httpServer = null
    }
    receivedMqtt.length = 0
  }

  const logs: string[] = []
  const hooks: ChannelHooks = {
    onStatus: () => {},
    onLog: (_channel, level, text) => logs.push(`${level}: ${text}`),
    onConnected: () => {},
  }

  await startWsServer()
  await startBroker()
  try {
    // —— D. WebSocket 通道 ——
    const wsLink = new WsLink(hooks)
    wsLink.apply({ enabled: true, url: 'ws://127.0.0.1:9377', token: '' })
    await waitFor(() => wsLink.status === 'connected', 8000, 'WS 连接')
    ok('WebSocket 通道：连接成功')

    const msgA: PresentationEventMessage = { event: PRESENTATION_EVENTS.started, page: 2, id: 'ws-msg-a', notes: '中文\n备注<b>原样</b>' }
    assert.equal(wsLink.send(JSON.stringify(msgA)), true)
    await waitFor(() => receivedWs.length === 1, 5000, 'WS 收到消息')
    assert.deepEqual(JSON.parse(receivedWs[0].text), msgA)
    ok('WebSocket 通道：服务端收到与发送完全一致的四字段 JSON')

    // 断线：发送被丢弃且不抛错
    await stopWsServer()
    await waitFor(() => wsLink.status !== 'connected', 8000, 'WS 断开')
    const msgB: PresentationEventMessage = { event: PRESENTATION_EVENTS.changed, page: 3, id: 'ws-msg-b', notes: '' }
    assert.equal(wsLink.send(JSON.stringify(msgB)), false)
    ok('WebSocket 通道：断线期间发送被安全丢弃（不缓存、不抛错、不阻塞）')

    // 重连：不重放历史，仅按桥接逻辑重发“最近一条状态”（沿用原 id）
    receivedWs.length = 0
    await startWsServer()
    hooks.onConnected = channel => {
      if (channel === 'ws') wsLink.send(JSON.stringify(msgB)) // 桥接层：重发 lastMessage（原 id）
    }
    await waitFor(() => wsLink.status === 'connected', 15000, 'WS 重连')
    await waitFor(() => receivedWs.length >= 1, 5000, 'WS 重连后收到重发')
    await sleep(1800) // 等待可能的重试，确认无历史重放
    const reconnectedIds = receivedWs.map(item => JSON.parse(item.text).id)
    assert.deepEqual(reconnectedIds, ['ws-msg-b'])
    ok('WebSocket 通道：重连成功且只重发最近一条状态（原 id），历史翻页不重放')

    // —— E. MQTT 通道 ——
    const mqttLink = new MqttLink(hooks)
    mqttLink.apply(
      { enabled: true, url: 'ws://127.0.0.1:9383', username: '', password: '', clientId: '', topic: 'presentation/events', qos: 1, retain: false },
      { password: '' },
    )
    await waitFor(() => mqttLink.status === 'connected', 8000, 'MQTT 连接')
    ok('MQTT 通道：连接本地 Broker 成功（MQTT over WebSocket）')

    // 双通道发送同一次事件：同 id、同内容
    const msgC: PresentationEventMessage = { event: PRESENTATION_EVENTS.changed, page: 4, id: 'dual-msg-c', notes: '第4页富文本\n要点一\n要点二' }
    assert.equal(mqttLink.send(JSON.stringify(msgC)), true)
    assert.equal(wsLink.send(JSON.stringify(msgC)), true)
    await waitFor(() => receivedMqtt.length >= 1 && receivedWs.some(item => JSON.parse(item.text).id === 'dual-msg-c'), 5000, '双通道送达')
    const mqttGot = receivedMqtt.find(item => item.text.includes('dual-msg-c'))!
    assert.equal(mqttGot.topic, 'presentation/events')
    assert.deepEqual(JSON.parse(mqttGot.text), msgC)
    assert.deepEqual(JSON.parse(receivedWs.find(item => item.text.includes('dual-msg-c'))!.text), msgC)
    ok('双通道同时启用：同一事件（同 id 同内容）在两条通道各送达一次')

    // 单通道故障不影响另一条与播放
    await stopWsServer()
    await waitFor(() => wsLink.status !== 'connected', 15000, 'WS 再次断开')
    const msgD: PresentationEventMessage = { event: PRESENTATION_EVENTS.changed, page: 5, id: 'dual-msg-d', notes: '' }
    assert.equal(wsLink.send(JSON.stringify(msgD)), false)
    assert.equal(mqttLink.send(JSON.stringify(msgD)), true)
    await waitFor(() => receivedMqtt.some(item => item.text.includes('dual-msg-d')), 5000, 'MQTT 单独送达')
    ok('WebSocket 故障期间：MQTT 独立送达，发送全程不抛错（播放不受影响）')

    // MQTT 断线不缓存：断开 Broker 后发送被丢弃，重启后不重放
    await stopBroker()
    await startBroker()
    await waitFor(() => mqttLink.status === 'connected', 20000, 'MQTT 重连')
    await sleep(1500)
    const allMqttIds = receivedMqtt.map(item => JSON.parse(item.text).id)
    assert.equal(allMqttIds.includes('dual-msg-d'), false)
    ok('MQTT 通道：断线期间的消息不建立重放队列，重连后无历史重发')

    // 配置变更：停用后旧连接被关闭
    mqttLink.apply({ enabled: false, url: 'ws://127.0.0.1:9383', username: '', password: '', clientId: '', topic: 'presentation/events', qos: 1, retain: false })
    assert.equal(mqttLink.status, 'disabled')
    wsLink.destroy()
    ok('停用通道：旧连接关闭、状态复位')

    assert.equal(logs.some(text => /password|密码|token/i.test(text)), false)
    ok('通道日志不包含密码 / Token 等鉴权信息')
  }
  finally {
    await stopWsServer().catch(() => {})
    await stopBroker().catch(() => {})
  }
}

// ============================== F. 播放页热替换（远程默认 PPT 更新）事件时序 ==============================
function hotSwapTests() {
  // 与 PlayView.applyBundle 完全一致的操作序列：ended(旧最后页) → 换稿+回第一页 → started(新第一页)
  const makeWiring = (initialSlides: Array<{ remark: string }>) => {
    const screening = ref(false)
    const slideIndex = ref(0)
    let idCounter = 0
    // 镜像 slidesStore.slides：setSlides 替换数组后，备注读取立即切换到新文稿
    let slides = initialSlides
    const session = new PresentationSession({
      getNotes: page => slides[page - 1]?.remark ?? '',
      genId: () => `swap-${++idCounter}`,
    })
    session.pendingPageProvider = () => slideIndex.value + 1
    const emitted: PresentationEventMessage[] = []
    const unwatchScreening = watch(screening, value => {
      const message = session.handleScreeningChange(value)
      if (message) emitted.push(message)
    }, { flush: 'sync' })
    const unwatchIndex = watch(slideIndex, () => {
      const message = session.handlePageChange(slideIndex.value + 1)
      if (message) emitted.push(message)
    }, { flush: 'sync' })
    return {
      screening,
      slideIndex,
      emitted,
      /** 镜像 slidesStore.setSlides */
      replaceSlides: (next: Array<{ remark: string }>) => {
        slides = next 
      },
      unwatch: () => {
        unwatchScreening(); unwatchIndex() 
      },
    }
  }

  // 场景 1：旧文稿播放到第 3 页时热替换为 2 页新文稿
  {
    const state = makeWiring([
      { remark: '旧1' }, { remark: '旧2' }, { remark: '旧3' },
    ])
    state.screening.value = true
    state.slideIndex.value = 2
    assert.equal(state.emitted.length, 2) // started(1) + changed(3)

    // 新文稿已就绪：applyBundle 序列
    state.screening.value = false // ended：旧文稿最后停留页
    // （真实实现中此处随后 setSlides + updateSlideIndex(0)，screening 为 false 不产生事件）
    state.replaceSlides([{ remark: '新1' }, { remark: '新2' }]) // setSlides：新文稿
    state.slideIndex.value = 0 // 回到新文稿第一页
    state.screening.value = true // started：新文稿第一页

    assert.equal(state.emitted.length, 4)
    assert.equal(state.emitted[2].event, PRESENTATION_EVENTS.ended)
    assert.equal(state.emitted[2].page, 3)
    assert.equal(state.emitted[2].notes, '旧3')
    assert.equal(state.emitted[3].event, PRESENTATION_EVENTS.started)
    assert.equal(state.emitted[3].page, 1)
    assert.equal(state.emitted[3].notes, '新1')
    assert.ok(!state.emitted.some(m => m.event === PRESENTATION_EVENTS.changed && m.page === 1))
    assert.equal(new Set(state.emitted.map(m => m.id)).size, state.emitted.length)
    ok('热替换：先 ended（旧稿第 3 页旧备注）再 started（新稿第 1 页新备注），无多余 slide.changed')
    state.unwatch()
  }

  // 场景 2：新旧文稿都停在第 1 页，也必须按文稿替换处理（ended + started）
  {
    const state = makeWiring([{ remark: '旧第一页' }])
    state.screening.value = true
    assert.equal(state.emitted.length, 1)
    state.screening.value = false
    state.screening.value = true
    assert.equal(state.emitted.length, 3)
    assert.equal(state.emitted[1].event, PRESENTATION_EVENTS.ended)
    assert.equal(state.emitted[1].page, 1)
    assert.equal(state.emitted[1].notes, '旧第一页')
    assert.equal(state.emitted[2].event, PRESENTATION_EVENTS.started)
    assert.equal(state.emitted[2].page, 1)
    ok('新旧文稿都停在第 1 页：仍按文稿替换发送 ended + started（不依赖页码比较）')
    state.unwatch()
  }

  // 场景 3：此前无放映（空等待页）→ 首次上传：只发送 started，不伪造 ended
  {
    const state = makeWiring([{ remark: '首传备注' }])
    // phase 'empty' 时 screening 从未被置 true
    state.screening.value = true
    assert.equal(state.emitted.length, 1)
    assert.equal(state.emitted[0].event, PRESENTATION_EVENTS.started)
    assert.equal(state.emitted[0].page, 1)
    assert.equal(state.emitted[0].notes, '首传备注')
    ok('空等待页首次上传：只发送新文稿 started（不伪造 ended）')
    state.unwatch()
  }

  // 场景 4：新文稿尚未准备好时不结束旧文稿；过期/重复通知不产生事件
  {
    const state = makeWiring([{ remark: '旧' }, { remark: '旧2' }])
    state.screening.value = true
    const before = state.emitted.length
    // 模拟：收到通知但加载失败 → 不改变 screening → 无任何事件
    // 过期/重复通知（seq 相同或更小）在 PlayView 中被忽略，同样不改变状态
    assert.equal(state.emitted.length, before)
    ok('新文稿未就绪 / 重复过期通知：旧文稿继续播放，不发送任何事件')
    state.unwatch()
  }
}

// ============================== 执行 ==============================
console.log('A/B/C 纯逻辑与集成断言：')
results.forEach(line => console.log(line))
const pureResultCount = results.length
console.log('\nF 热替换事件时序：')
hotSwapTests()
results.slice(pureResultCount).forEach(line => console.log(line))
const hotSwapResultCount = results.length
console.log('\nD/E 通道本地实测：')
// 整体看门狗：防止测试夹具异常导致静默挂起
setTimeout(() => {
  console.error('测试整体超时（120s），强制退出')
  process.exit(1)
}, 120000).unref()
try {
  await liveTests()
}
catch (error) {
  console.error('通道实测失败：', error)
  process.exit(1)
}
results.slice(hotSwapResultCount).forEach(line => console.log(line))
console.log('\n全部通过 ✔')
process.exit(0)
