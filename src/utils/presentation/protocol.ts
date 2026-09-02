/**
 * 放映联动对外协议
 *
 * 对外仅使用固定的四字段 JSON 对象（两种通道完全一致，无外层包装）：
 * { event, page, id, notes }
 * 不携带 version / timestamp / session_id / seq 等任何附加字段。
 */
import { nanoid } from 'nanoid'

export const PRESENTATION_EVENTS = {
  started: 'presentation.started',
  changed: 'slide.changed',
  ended: 'presentation.ended',
} as const

export type PresentationEventType = (typeof PRESENTATION_EVENTS)[keyof typeof PRESENTATION_EVENTS]

export interface PresentationEventMessage {
  /** 事件类型，仅限 presentation.started / slide.changed / presentation.ended */
  event: PresentationEventType
  /** 对外页码，从 1 开始 */
  page: number
  /** 唯一消息标识：同一次真实事件经两种通道发送时共用同一个 id */
  id: string
  /** 当前页演讲者备注（纯文本），无备注时为空字符串 */
  notes: string
}

export const DEFAULT_MESSAGE_ID_GENERATOR = () => nanoid(12)

export function buildPresentationMessage(
  event: PresentationEventType,
  page: number,
  notes: string,
  genId: () => string = DEFAULT_MESSAGE_ID_GENERATOR,
): PresentationEventMessage {
  return {
    event,
    page,
    id: genId(),
    notes,
  }
}

// —— 通道连接状态（供设置界面展示） ——
export type ChannelStatus =
  | 'disabled' // 未启用
  | 'disconnected' // 未连接
  | 'connecting' // 连接中
  | 'connected' // 已连接
  | 'reconnecting' // 重连中
  | 'failed' // 连接失败

export const CHANNEL_STATUS_LABELS: Record<ChannelStatus, string> = {
  disabled: '未启用',
  disconnected: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  failed: '连接失败',
}

export const CHANNEL_STATUS_LEVELS: Record<ChannelStatus, 'neutral' | 'info' | 'success' | 'warning' | 'error'> = {
  disabled: 'neutral',
  disconnected: 'neutral',
  connecting: 'info',
  connected: 'success',
  reconnecting: 'warning',
  failed: 'error',
}
