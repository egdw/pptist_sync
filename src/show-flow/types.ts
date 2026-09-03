/**
 * Virtual Show Flow —— 多屏联动编排模块类型定义
 *
 * 核心原则：
 * 1. 所有跨屏引用一律使用稳定 pageId（PPTist = slideId，Reveal = data-page-id），
 *    页码仅用于 UI 显示，绝不持久化。
 * 2. ShowFlow 是独立于真实 PPT 页码的虚拟播放序列。
 */
import type { Slide } from '@/types/slides'

export type ScreenRole = 'main' | 'secondary'

export type SourceKind = 'pptist' | 'reveal-md'

/** 内容源（主屏 / 副屏各自注册一个） */
export interface ContentSource {
  id: string
  kind: SourceKind
  name: string
  role: ScreenRole
  /** reveal-md：markdown 的服务端静态路径（如 /reveal/slides.md）；pptist 恒为 'local' */
  mdPath?: string
  /** 源内容指纹，用于 reconciliation 判断是否需要重新对账 */
  manifestVersion?: string
}

export interface PageManifest {
  /** 稳定页面 ID：PPTist 用 slide.id；Reveal 用 data-page-id（缺省时按 section 内容生成稳定 hash） */
  id: string
  /** 真实页码（从 1 开始），仅用于 UI 显示，禁止用于持久引用 */
  index: number
  title: string
  /** PPTist 提供（由 slideId 推导的缩略图路径），Reveal 无 */
  thumbnail?: string
  notes?: string
  /** Reveal: data-stage */
  stage?: string
  /** Reveal: data-tablet-scene */
  tabletScene?: string
}

export interface ScreenAdapter {
  getManifest(): Promise<PageManifest[]>
  /** 幂等：同一 commandId 多次调用只实际执行一次。resolve 即代表页面切换完成且渲染过至少一帧（ACK 前置条件） */
  gotoById(pageId: string, commandId: string): Promise<void>
  getCurrentPageId(): string | null
  refresh(): Promise<void>
}

export type ScreenTargetAction = 'goto' | 'keep'

export interface ScreenTarget {
  action: ScreenTargetAction
  pageId?: string
}

export interface ShowStep {
  id: string
  order: number
  label?: string
  main?: ScreenTarget
  secondary?: ScreenTarget
  tablet?: { scene?: string }
  mqtt?: { topic?: string; payload?: unknown }
  websocket?: { event?: string; payload?: unknown }
  /** 其他事件（MQTT/平板）相对页面切换的触发时机，默认 afterAck */
  eventTiming?: 'beforeNavigate' | 'afterNavigate' | 'afterAck'
}

export interface ShowFlow {
  id: string
  name: string
  enabled: boolean
  confirmationEnabled: boolean
  confirmationMode: 'strict' | 'loose'
  mainSourceId: string
  secondarySourceId?: string
  /** 当前编辑光标（最近一次执行到的 Step），仅编辑/控制台状态，非持久强制项 */
  currentStepId?: string
  steps: ShowStep[]
}

/** 持久化整体结构 */
export interface ShowFlowPersistence {
  version: 1
  sources: ContentSource[]
  flow: ShowFlow
  /** 已编排但从未出现在任何 Step 里的提示信息：未编排页面池按 sourceId 分组 */
  unmappedPool?: Record<string, string[]>
}

/** reconciliation 结果报告 */
export interface ReconciliationReport {
  kept: number
  updated: number
  added: number
  removed: number
  removedNodeRefs: number
  removedSteps: string[]
  messages: string[]
}

/** Controller / 客户端运行状态 */
export type ShowFlowPhase = 'READY' | 'TRANSITIONING'

export interface StepTargetSnapshot {
  stepId: string
  seq: number
  mainPageId: string | null
  secondaryPageId: string | null
  tabletScene: string | null
}

/** 在线状态（心跳结果） */
export interface OnlineStatus {
  main: boolean
  secondary: boolean
  mqtt: boolean
  tablets: boolean[]
}
