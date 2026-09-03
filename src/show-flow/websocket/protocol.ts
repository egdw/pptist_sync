/**
 * ShowFlow WebSocket 协议。
 *
 * 可靠性约定：
 * - NAVIGATE 携带 commandId，作为幂等键：客户端收到重复 commandId 只执行一次
 * - ACK 必须在页面真实切换 + 至少一帧渲染后回发，禁止收到消息立即 ACK
 * - 重试沿用同一 commandId（1.5s 超时，最多重试 3 次）
 * - Controller 永远保存完整目标状态快照，断线重连通过 SYNC_STATE 恢复，不依赖事件补发
 */
import type { StepTargetSnapshot } from '../types'

export const SHOWFLOW_WS_PATH = '/showflow'

export type ShowFlowRole = 'controller' | 'main' | 'secondary' | 'tablet' | 'console'

export type ShowFlowMessageType =
  | 'HELLO' | 'HELLO_ACK'
  | 'PING' | 'PONG'
  | 'NAVIGATE' | 'ACK'
  | 'SYNC_STATE' | 'ERROR'

export interface ShowFlowMessage {
  type: ShowFlowMessageType
  /** 会话标识，由 Controller 创建并随 SYNC_STATE 下发 */
  sessionId?: string
  /** 幂等键（NAVIGATE/ACK 必填） */
  commandId?: string
  stepId?: string
  pageId?: string
  /** 发送方角色 */
  role?: ShowFlowRole
  rendered?: boolean
  /** SYNC_STATE 载荷 */
  state?: StepTargetSnapshot
  code?: string
  message?: string
  /** 客户端自定义：HELLO 时声明屏幕名称等 */
  meta?: Record<string, unknown>
}

export const ACK_TIMEOUT_MS = 1500
export const ACK_MAX_RETRIES = 3
export const HEARTBEAT_INTERVAL_MS = 2000
export const OFFLINE_THRESHOLD_MS = 6000
/** loose 模式下等待 ACK 的最大时长，超过后允许继续但保持异常提示 */
export const LOOSE_ACK_GIVEUP_MS = 4500
/** READY 态防连击 debounce */
export const KEY_DEBOUNCE_MS = 200

export function isShowFlowMessage(data: unknown): data is ShowFlowMessage {
  return !!data && typeof data === 'object' && typeof (data as ShowFlowMessage).type === 'string'
}
