import { remarkToPlainText } from '../../utils/presentation/remarkText.ts'
import type { LcdSceneState } from '../types'
import { createLcdSceneState } from './lcd-state.ts'

export function parsePptLcdRemark(remark: unknown, pageId = ''): LcdSceneState | null {
  try {
    const text = remarkToPlainText(typeof remark === 'string' ? remark : '')
    const block = text.match(/\[LCD\]([\s\S]*?)\[\/LCD\]/i)
    if (!block) return null
    const values: Record<string, string> = {}
    for (const rawLine of block[1].split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const equals = line.indexOf('=')
      if (equals <= 0) continue
      values[line.slice(0, equals).trim().toLowerCase()] = line.slice(equals + 1).trim()
    }
    return createLcdSceneState({ type: 'pptist', pageId }, values)
  }
  catch (error) {
    console.warn('[ShowFlow LCD] LCD 配置解析失败，保持上一状态', error)
    return null
  }
}
