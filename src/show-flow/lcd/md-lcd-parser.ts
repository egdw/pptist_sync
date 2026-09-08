import type { LcdSceneState } from '../types'
import { createLcdSceneState } from './lcd-state.ts'

export function parseMarkdownLcd(attrs: Record<string, string>, pageId: string): LcdSceneState | null {
  const hasLcdData = ['stage', 'lead', 'active', 'collab'].some(key => attrs[key] !== undefined)
  if (!hasLcdData) return null
  const values: Record<string, string> = {
    stage: attrs.stage || '', lead: attrs.lead || '', active: attrs.active || '',
  }
  for (const item of (attrs.collab || '').split(';')) {
    const equals = item.indexOf('=')
    if (equals > 0) values[item.slice(0, equals).trim().toLowerCase()] = item.slice(equals + 1).trim()
  }
  return createLcdSceneState({ type: 'reveal-md', pageId }, values)
}
