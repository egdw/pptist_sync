import type { LcdSceneState, LcdRole } from '../types'

export interface LedScreenImage {
  role: LcdRole
  url: string
  format: 'jpeg'
  width: 1280
  height: 800
  sha256: string
}
export interface LedRenderResult { revision: number; screens: LedScreenImage[] }

export async function renderLcdState(state: LcdSceneState): Promise<LedRenderResult> {
  const response = await fetch('/led-render-api/render', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }),
  })
  if (!response.ok) throw new Error(`LCD Renderer 返回 ${response.status}`)
  return response.json()
}
