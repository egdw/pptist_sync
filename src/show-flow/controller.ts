/**
 * Show Controller —— 联动播放唯一时间轴。
 *
 * 职责：
 * - next/previous/goto：按虚拟 Step 序列推进，绝不知道"真实页码"
 * - 每个 Step 的完整目标状态快照（keep 继承上一快照），前进/后退/跳转/断线恢复均为快照恢复
 * - ACK 聚合 + 超时重试（同一 commandId）+ 幂等
 * - strict / loose 确认模式；手动兜底操作（重发/重同步/强制完成/跳过副屏）
 * - 断线重连：远端 HELLO 时回发 SYNC_STATE 完整快照
 */
import { nanoid } from 'nanoid'
import type {
  ScreenAdapter,
  ShowFlowPhase,
  StepTargetSnapshot,
} from './types'
import {
  ACK_MAX_RETRIES,
  ACK_TIMEOUT_MS,
  KEY_DEBOUNCE_MS,
  LOOSE_ACK_GIVEUP_MS,
} from './websocket/protocol'
import type { ShowFlowMessage } from './websocket/protocol'
import type { ShowFlowTransport } from './adapters/reveal'

interface PendingAck {
  commandId: string
  role: 'main' | 'secondary'
  stepId: string
  pageId: string
  timer?: ReturnType<typeof setTimeout>
  retries: number
  giveupTimer?: ReturnType<typeof setTimeout>
}

export interface ControllerCallbacks {
  onPhaseChange: (phase: ShowFlowPhase) => void
  onStepChange: (snapshot: StepTargetSnapshot | null) => void
  onNotice: (text: string, type?: 'info' | 'warning' | 'error' | 'success') => void
  onEventAction?: (stepId: string, timing: string) => void
  /** 仅 Controller 调用；副屏 ACK 完成后应用页面 LCD，force 用于重新同步。 */
  onLcdPage?: (pageId: string | null, force?: boolean) => Promise<void> | void
}

export class ShowFlowController {
  phase: ShowFlowPhase = 'READY'
  sessionId = ''
  seq = 0
  /** 当前 Step 在 steps 中的下标（-1 = 未开始） */
  currentStepIndex = -1
  snapshot: StepTargetSnapshot | null = null
  private pendingAcks = new Map<string, PendingAck>()
  private lastActionAt = 0
  private looseAbnormal = false
  /** 各屏最近一次已实际导航到的 pageId（用于 keep 步骤的漂移补偿） */
  private appliedMainPageId: string | null = null
  private appliedSecondaryPageId: string | null = null

  private getAdapters: () => { main: ScreenAdapter; secondary: ScreenAdapter | null }
  private transport: ShowFlowTransport
  private callbacks: ControllerCallbacks
  private getConfig: () => { enabled: boolean; confirmationEnabled: boolean; confirmationMode: 'strict' | 'loose'; stepCount: number }

  constructor(
    getAdapters: () => { main: ScreenAdapter; secondary: ScreenAdapter | null },
    transport: ShowFlowTransport,
    callbacks: ControllerCallbacks,
    getConfig: () => { enabled: boolean; confirmationEnabled: boolean; confirmationMode: 'strict' | 'loose'; stepCount: number },
  ) {
    this.getAdapters = getAdapters
    this.transport = transport
    this.callbacks = callbacks
    this.getConfig = getConfig
  }

  get ready(): boolean {
    return this.phase === 'READY'
  }

  get isAbnormal(): boolean {
    return this.looseAbnormal || this.pendingAcks.size > 0
  }

  private setPhase(phase: ShowFlowPhase) {
    this.phase = phase
    this.callbacks.onPhaseChange(phase)
  }

  private newSession() {
    this.sessionId = `sess-${nanoid(8)}`
    this.seq = 0
    this.currentStepIndex = -1
    this.snapshot = null
    this.looseAbnormal = false
    this.appliedMainPageId = null
    this.appliedSecondaryPageId = null
  }

  /**
   * 计算某 Step 的完整目标状态快照：从 Step 0 折叠到目标 Step（keep 继承最近一次 goto）。
   * 纯函数、与导航方向无关 —— 前进/后退/跳转/断线恢复得到的同一 Step 状态永远一致。
   */
  private resolveSnapshot(stepIndex: number): StepTargetSnapshot | null {
    const step = this.flowContext.getStep(stepIndex)
    if (!step) return null
    let mainPageId: string | null = null
    let secondaryPageId: string | null = null
    let tabletScene: string | null = null
    for (let i = 0; i <= stepIndex; i++) {
      const s = this.flowContext.getStep(i)
      if (!s) break
      if (s.main?.action === 'goto' && s.main.pageId) mainPageId = s.main.pageId
      if (s.secondary?.action === 'goto' && s.secondary.pageId) secondaryPageId = s.secondary.pageId
      if (s.tablet?.scene) tabletScene = s.tablet.scene
    }
    return { stepId: step.id, seq: ++this.seq, mainPageId, secondaryPageId, tabletScene }
  }

  /** 由 store 注入虚拟序列访问器（响应式数据不入 controller 内部状态） */
  private flowContext: { getStep: (i: number) => import('./types').ShowStep | undefined } = { getStep: () => undefined }
  registerStepsAccessor(getStep: (i: number) => import('./types').ShowStep | undefined) {
    this.flowContext = { getStep }
  }

  /** 开始联动会话：重置状态并直接落位到 stepIndex（默认第一步） */
  async start(stepIndex = 0) {
    if (!this.getConfig().enabled) return
    this.newSession()
    this.setPhase('READY')
    await this.applyStep(stepIndex)
  }

  stop() {
    this.newSession()
    this.setPhase('READY')
    this.callbacks.onStepChange(null)
  }

  /** 前进一个虚拟 Step。返回是否实际执行 */
  async next(): Promise<boolean> {
    if (!this.getConfig().enabled) return false
    if (!this.ready) {
      this.callbacks.onNotice('当前步骤尚未确认完成，已忽略本次操作', 'warning')
      return false
    }
    const now = Date.now()
    if (now - this.lastActionAt < KEY_DEBOUNCE_MS) return false
    this.lastActionAt = now

    const nextIndex = this.currentStepIndex + 1
    if (nextIndex >= this.getConfig().stepCount) {
      this.callbacks.onNotice('已经是最后一个虚拟步骤了', 'info')
      return false
    }
    return this.applyStep(nextIndex)
  }

  /** 后退一个虚拟 Step：整体快照恢复到上一 Step，而非各屏各自 previous */
  async previous(): Promise<boolean> {
    if (!this.getConfig().enabled) return false
    if (!this.ready) {
      this.callbacks.onNotice('当前步骤尚未确认完成，已忽略本次操作', 'warning')
      return false
    }
    const now = Date.now()
    if (now - this.lastActionAt < KEY_DEBOUNCE_MS) return false
    this.lastActionAt = now

    if (this.currentStepIndex <= 0) {
      this.callbacks.onNotice('已经是第一个虚拟步骤了', 'info')
      return false
    }
    return this.applyStep(this.currentStepIndex - 1)
  }

  /** 跳转到指定 Step（断线恢复 / 控制台点击） */
  async gotoStep(stepIndex: number) {
    if (!this.ready) return false
    return this.applyStep(stepIndex)
  }

  private async applyStep(stepIndex: number): Promise<boolean> {
    const step = this.flowContext.getStep(stepIndex)
    if (!step) return false

    const targetSnapshot = this.resolveSnapshot(stepIndex)
    if (!targetSnapshot) return false

    // 事件触发时机（MQTT/平板，阶段 4 接入；当前仅回调通知）
    const timing = step.eventTiming || 'afterAck'
    if (timing === 'beforeNavigate') this.callbacks.onEventAction?.(step.id, timing)

    const { main, secondary } = this.getAdapters()
    const mainTargetId = step.main?.action === 'goto' ? step.main.pageId ?? null : null
    const secondaryTargetId = step.secondary?.action === 'goto' ? step.secondary.pageId ?? null : null

    // keep ≠ 不导航：若当前快照与已应用状态漂移（典型为后退后 keep 指向更早的页面），
    // 需要补偿导航把屏幕拉回目标状态；无漂移时保持不动，避免打扰正在展示的页面
    const mainDrifted = !!targetSnapshot.mainPageId && targetSnapshot.mainPageId !== this.appliedMainPageId
    const secondaryDrifted = !!targetSnapshot.secondaryPageId && targetSnapshot.secondaryPageId !== this.appliedSecondaryPageId
    const mainPageToApply = mainTargetId ?? (mainDrifted ? targetSnapshot.mainPageId : null)
    const secondaryPageToApply = secondaryTargetId ?? (secondaryDrifted ? targetSnapshot.secondaryPageId : null)

    const needsConfirm = this.getConfig().confirmationEnabled
    const mode = this.getConfig().confirmationMode

    // 无任何屏幕导航的事件型 Step：立即完成
    if (!mainPageToApply && !secondaryPageToApply) {
      this.currentStepIndex = stepIndex
      this.snapshot = targetSnapshot
      this.callbacks.onStepChange(targetSnapshot)
      if (timing !== 'beforeNavigate') this.callbacks.onEventAction?.(step.id, timing)
      return true
    }

    this.setPhase('TRANSITIONING')
    this.looseAbnormal = false
    const commandId = `cmd-${nanoid(8)}`
    let allAcked = true

    // 主屏（本地）
    if (mainPageToApply && main) {
      try {
        if (needsConfirm && mode === 'strict') {
          await main.gotoById(mainPageToApply, commandId)
        }
        else {
          main.gotoById(mainPageToApply, commandId).catch(() => {})
        }
        this.appliedMainPageId = mainPageToApply
      }
      catch (err) {
        allAcked = false
        this.callbacks.onNotice(`主屏切换失败：${(err as Error).message}`, 'error')
      }
    }

    // 副屏（远程）
    if (secondaryPageToApply && secondary) {
      secondary.gotoById(secondaryPageToApply, commandId)
      if (needsConfirm) {
        const acked = await this.waitForAck(commandId, secondaryPageToApply, step.id, mode)
        if (!acked) {
          allAcked = false
          if (mode === 'strict') {
            this.callbacks.onNotice(`副屏未在时限内确认（${secondaryPageToApply}），可点「重发」或「强制完成」`, 'error')
          }
          else {
            this.looseAbnormal = true
            this.callbacks.onNotice('副屏确认超时，已按宽松模式继续', 'warning')
          }
        }
        else {
          this.appliedSecondaryPageId = secondaryPageToApply
        }
      }
      else {
        this.appliedSecondaryPageId = secondaryPageToApply
      }
    }

    this.currentStepIndex = stepIndex
    this.snapshot = targetSnapshot
    this.callbacks.onStepChange(targetSnapshot)
    // LCD 与 resolved secondary snapshot 绑定。真实副屏导航时必须等 ACK（若关闭确认则在导航下发后）。
    if (secondaryPageToApply && (allAcked || !needsConfirm)) {
      await this.callbacks.onLcdPage?.(targetSnapshot.secondaryPageId)
    }
    if (timing !== 'beforeNavigate') this.callbacks.onEventAction?.(step.id, timing)

    // 只有全部 ACK 后才回到 READY；strict 失败时保持 TRANSITIONING，由手动兜底解锁
    if (allAcked) this.setPhase('READY')
    else this.callbacks.onPhaseChange(this.phase)
    return true
  }

  /** 等待指定 commandId 的副屏 ACK；超时重试（同一 commandId），strict 下重试耗尽返回 false */
  private waitForAck(commandId: string, pageId: string, stepId: string, mode: 'strict' | 'loose'): Promise<boolean> {
    return new Promise(resolve => {
      const pending: PendingAck = {
        commandId,
        role: 'secondary',
        stepId,
        pageId,
        retries: 0,
      }
      this.pendingAcks.set(commandId, pending)

      const giveUpLoose = () => {
        if (mode === 'loose') {
          cleanup(false)
          resolve(false)
        }
      }
      if (mode === 'loose') pending.giveupTimer = setTimeout(giveUpLoose, LOOSE_ACK_GIVEUP_MS)

      const retry = () => {
        if (!this.pendingAcks.has(commandId)) return
        if (pending.retries >= ACK_MAX_RETRIES) {
          cleanup(false)
          resolve(false)
          return
        }
        pending.retries++
        // 重发同一 commandId（客户端幂等，重复收到不会二次执行）
        this.transport.sendToRole('secondary', {
          type: 'NAVIGATE',
          commandId,
          stepId: pending.stepId,
          pageId: pending.pageId,
          role: 'secondary',
        })
        pending.timer = setTimeout(retry, ACK_TIMEOUT_MS)
      }
      pending.timer = setTimeout(retry, ACK_TIMEOUT_MS)

      const cleanup = (result: boolean) => {
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.giveupTimer) clearTimeout(pending.giveupTimer)
        this.pendingAcks.delete(commandId)
        resolve(result)
      }
      ;(pending as PendingAck & { cleanup?: (r: boolean) => void }).cleanup = cleanup
    })
  }

  /** 收到 WS 消息（由 store 转发） */
  handleWsMessage(msg: ShowFlowMessage) {
    if (msg.type === 'ACK' && msg.commandId) {
      const pending = this.pendingAcks.get(msg.commandId)
      if (pending) {
        // 幂等：重复 ACK 直接忽略（清理后查不到）；正常确认静默处理，不弹提示打扰放映
        ;(pending as PendingAck & { cleanup?: (r: boolean) => void }).cleanup?.(true)
      }
      return
    }
    if (msg.type === 'HELLO' && msg.role === 'secondary') {
      // 断线重连：下发完整快照，客户端直接恢复当前状态（不依赖事件补发）
      this.resyncAll()
    }
  }

  /** 手动兜底：重发当前步骤（同一快照重新导航，新 commandId） */
  async resendCurrent() {
    if (this.currentStepIndex < 0) return
    this.callbacks.onNotice('重新发送当前步骤 ...', 'info')
    this.setPhase('READY')
    await this.applyStep(this.currentStepIndex)
  }

  /** 手动兜底：向全部屏幕重新同步当前完整状态 */
  resyncAll() {
    const snap = this.snapshot
    if (!snap) return
    this.transport.sendToRole('secondary', {
      type: 'SYNC_STATE',
      sessionId: this.sessionId,
      state: snap,
    })
    this.transport.sendToRole('secondary', {
      type: 'NAVIGATE',
      commandId: `resync-${nanoid(6)}`,
      stepId: snap.stepId,
      pageId: snap.secondaryPageId ?? '',
      role: 'secondary',
    })
    this.callbacks.onNotice('已向全部屏幕发送状态同步', 'info')
    void this.callbacks.onLcdPage?.(snap.secondaryPageId, true)
  }

  /** 手动兜底：强制完成当前步骤（strict 卡死时解锁） */
  forceComplete() {
    for (const [, pending] of this.pendingAcks) {
      if (pending.timer) clearTimeout(pending.timer)
      if (pending.giveupTimer) clearTimeout(pending.giveupTimer)
    }
    this.pendingAcks.clear()
    this.looseAbnormal = false
    this.setPhase('READY')
    this.callbacks.onNotice('已强制完成当前步骤', 'warning')
  }

  /** 手动兜底：跳过副屏（仅对主屏继续推进，本次会话内副屏不再确认） */
  skipSecondary() {
    this.forceComplete()
    this.callbacks.onNotice('已跳过副屏确认，仅控制主屏继续', 'warning')
  }
}
