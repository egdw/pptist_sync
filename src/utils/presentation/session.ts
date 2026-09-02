/**
 * 放映会话状态机（纯逻辑，不依赖 Vue / DOM，便于针对性验证）
 *
 * 事件全部由“主控窗口的放映状态与实际页码变化”驱动：
 * - handleScreeningChange(true)  → 至多产生一次 presentation.started（携带当前页）
 * - handlePageChange(page)       → 页码真实变化时产生一次 slide.changed
 * - handleScreeningChange(false) → 至多产生一次 presentation.ended（携带最后停留页）
 *
 * 相同页码不重复触发；页码从 1 开始对外。
 * notes 由调用方按“当前页码对应的备注”即时提供，保证新页码不会配上旧备注。
 */
import { PRESENTATION_EVENTS, buildPresentationMessage, type PresentationEventMessage } from './protocol'

export interface PresentationSessionOptions {
  /** 根据对外页码（1 开始）即时读取该页备注纯文本 */
  getNotes: (page: number) => string
  /** 唯一 id 生成器（默认使用项目内 nanoid） */
  genId?: () => string
}

export class PresentationSession {
  /** 当前是否处于放映会话中 */
  active = false
  /** 最近一次真实发出的消息（连接恢复时可原样重发，沿用原 id） */
  lastMessage: PresentationEventMessage | null = null
  /** 由桥接层注入：读取“当前实际页码”（1 开始），保证 started/ended 使用实时页码 */
  pendingPageProvider: (() => number | null) | null = null
  private lastEmittedPage: number | null = null
  private readonly options: PresentationSessionOptions

  constructor(options: PresentationSessionOptions) {
    this.options = options
  }

  /**
   * 放映状态变化。返回需要对外发送的消息；无事件时返回 null。
   * 注意：结束放映时必须在页码等状态被清理之前调用本方法。
   */
  handleScreeningChange(screening: boolean): PresentationEventMessage | null {
    if (screening) {
      // 已在放映中（如普通/演讲者视图切换、重复触发）不视为重新开始
      if (this.active) return null
      this.active = true
      this.lastEmittedPage = null

      const page = this.currentPendingPage() ?? 1
      const message = this.build(PRESENTATION_EVENTS.started, page)
      this.lastEmittedPage = page
      this.lastMessage = message
      return message
    }

    if (!this.active) return null
    this.active = false

    // 最后停留页：优先使用当前实际页码，异常情况下回退到最近一次发出的页码
    const page = this.currentPendingPage() ?? this.lastEmittedPage
    this.lastEmittedPage = null
    if (page === null) {
      this.lastMessage = null
      return null
    }
    const message = this.build(PRESENTATION_EVENTS.ended, page)
    this.lastMessage = message
    return message
  }

  /**
   * 页码变化（对外页码，1 开始）。仅放映中且页码真实变化时产生 slide.changed。
   * 回到上一页属于真实切页，正常发送；越界或相同页码不发送。
   */
  handlePageChange(page: number): PresentationEventMessage | null {
    if (!this.active) return null
    if (!Number.isInteger(page) || page < 1) return null
    if (page === this.lastEmittedPage) return null

    const message = this.build(PRESENTATION_EVENTS.changed, page)
    this.lastEmittedPage = page
    this.lastMessage = message
    return message
  }

  /** 重置会话（如应用卸载时的清理），不产生事件 */
  reset() {
    this.active = false
    this.lastEmittedPage = null
    this.lastMessage = null
  }

  private currentPendingPage(): number | null {
    return this.pendingPageProvider ? this.pendingPageProvider() : null
  }

  private build(event: PresentationEventMessage['event'], page: number): PresentationEventMessage {
    return buildPresentationMessage(event, page, this.options.getNotes(page), this.options.genId)
  }
}
