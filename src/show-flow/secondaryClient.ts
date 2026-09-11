/**
 * PPTist 副屏（PPTist B）ShowFlow 协议客户端 —— 纯协议层，不依赖 WebSocket / Vue。
 *
 * 职责：
 * - NAVIGATE 幂等：同一 commandId 只实际执行一次；重复收到视为 ACK 丢失后的重发，直接补 ACK
 * - ACK 时机：navigate() Promise resolve 之后（视图层保证 = 切页 + nextTick + 至少一帧渲染）
 * - SYNC_STATE：捕获 sessionId 并按快照中的副屏 pageId 恢复完整状态
 * - 心跳应答：PING → PONG
 *
 * controlled 语义：收到过至少一次 NAVIGATE/SYNC_STATE 即进入受控态（抑制本机翻页）；
 * WS 断开时由视图层调用 reset() 恢复本机控制权（现场兜底）。
 */
import type { ShowFlowMessage } from './websocket/protocol'

export interface SecondaryShowFlowClientOptions {
  send: (msg: ShowFlowMessage) => void
  /** 切换到目标 pageId；resolve 代表页面已切换并完成渲染（之后才允许 ACK） */
  navigate: (pageId: string) => Promise<void>
  /** controlled 状态变化回调（视图层据此抑制/恢复本机翻页） */
  onControlledChange?: (controlled: boolean) => void
}

const MAX_EXECUTED_RECORDS = 32

export class SecondaryShowFlowClient {
  private executed = new Set<string>()
  private order: string[] = []
  private controlled = false
  private navigating = new Map<string, Promise<void>>()
  private generation = 0
  private renderedPageId: string | null = null
  sessionId: string | null = null

  constructor(private options: SecondaryShowFlowClientOptions) {}

  private setControlled(v: boolean) {
    if (this.controlled === v) return
    this.controlled = v
    this.options.onControlledChange?.(v)
  }

  /** WS 断开时调用：交还本机控制权 */
  reset() {
    this.generation++
    this.renderedPageId = null
    this.executed.clear()
    this.order = []
    this.navigating.clear()
    this.setControlled(false)
  }

  handleMessage(msg: ShowFlowMessage) {
    switch (msg.type) {
      case 'HELLO_ACK':
        this.sessionId = msg.sessionId ?? this.sessionId
        break
      case 'PING':
        this.options.send({ type: 'PONG' })
        break
      case 'SYNC_STATE':
        if (msg.sessionId) this.sessionId = msg.sessionId
        this.execNavigate(msg.state?.secondaryPageId ?? null, msg.commandId)
        break
      case 'NAVIGATE':
        this.execNavigate(msg.pageId ?? null, msg.commandId)
        break
      default:
        break
    }
  }

  private async execNavigate(pageId: string | null, commandId?: string) {
    if (!pageId) return
    this.setControlled(true)
    const existing = commandId ? this.navigating.get(commandId) : null
    if (existing) { await existing; return }
    const generation = ++this.generation

    // 幂等：已执行过的 commandId（ACK 丢失后的重发）不再切页，直接补 ACK
    if (commandId && this.executed.has(commandId) && this.renderedPageId === pageId) {
      this.ack(commandId, pageId)
      return
    }
    const navigation = Promise.resolve().then(() => this.options.navigate(pageId))
    if (commandId) this.navigating.set(commandId, navigation.catch(() => {}))
    try {
      await navigation
    }
    catch (err) {
      this.options.send({
        type: 'ERROR',
        code: 'NAVIGATE_FAILED',
        commandId,
        message: (err as Error).message,
      })
      if (commandId) {
        // 失败的 commandId 不占据幂等记录，允许重试真正执行
        this.executed.delete(commandId)
        const i = this.order.indexOf(commandId)
        if (i !== -1) this.order.splice(i, 1)
      }
      return
    }
    finally { if (commandId) this.navigating.delete(commandId) }
    if (generation !== this.generation) return
    this.renderedPageId = pageId
    if (commandId) {
      this.executed.add(commandId)
      this.order.push(commandId)
      if (this.order.length > MAX_EXECUTED_RECORDS) {
        const oldest = this.order.shift()
        if (oldest) this.executed.delete(oldest)
      }
    }
    if (commandId) this.ack(commandId, pageId)
  }

  private ack(commandId: string, pageId: string) {
    this.options.send({
      type: 'ACK',
      commandId,
      pageId,
      stepId: undefined,
      rendered: true,
    })
  }
}
