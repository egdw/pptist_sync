import type { LcdSceneState, LcdRole } from '../types'

export interface LedScreenImage {
  role: LcdRole
  url: string
  format: 'jpeg'
  width: 1280
  height: 800
  sha256: string
}
export interface LedRenderResult { revision: number; screens: LedScreenImage[]; /** 服务端代发布状态：true 已送达 / 'queued' 掉线排队重试 / false 未配置(浏览器兜底) */
  published?: boolean | 'queued' }

export async function renderLcdState(state: LcdSceneState, options: { theme?: Record<string, unknown>; publish?: boolean } = {}): Promise<LedRenderResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch('/led-render-api/render', {
      signal: controller.signal,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, theme: options.theme, publish: options.publish === true }),
    })
    if (!response.ok) throw new Error(`LCD Renderer 返回 ${response.status}`)
    return await response.json()
  }
  finally { clearTimeout(timer) }
}
