import { nanoid } from 'nanoid'
import type { LcdSceneState, PageManifest } from '../types'
import { renderLcdState, type LedRenderResult } from './render-client'

export interface LcdControllerOptions {
  getPage: (pageId: string) => PageManifest | undefined
  publish: (topic: string, payload: unknown) => boolean
  onNotice?: (text: string, type?: 'info' | 'warning' | 'error' | 'success') => void
}

export class LcdController {
  private lastPageId: string | null = null
  private queue = Promise.resolve()
  constructor(private options: LcdControllerOptions) {}

  applyPage(pageId: string | null, force = false): Promise<void> {
    this.queue = this.queue.then(() => this.apply(pageId, force)).catch(error => {
      console.error('[ShowFlow LCD] LCD 配置应用失败', error)
      this.options.onNotice?.(`LCD 配置应用失败：${error instanceof Error ? error.message : error}`, 'error')
    })
    return this.queue
  }

  private async apply(pageId: string | null, force: boolean) {
    if (!pageId || (!force && pageId === this.lastPageId)) return
    const page = this.options.getPage(pageId)
    if (!page?.lcd) return // 没有 LCD 块：严格保持上一状态，不发布
    const result = await renderLcdState(page.lcd)
    this.publish(result, page.lcd)
    this.lastPageId = pageId
    this.options.onNotice?.(`LCD 已更新（revision ${result.revision}）`, 'success')
  }

  private publish(result: LedRenderResult, _state: LcdSceneState) {
    for (const screen of result.screens) {
      const payload = {
        protocol: 'led-display/1.0', type: 'display', msg_id: nanoid(8),
        revision: result.revision, role: screen.role,
        image: { url: screen.url, format: screen.format, width: screen.width, height: screen.height, sha256: screen.sha256 },
      }
      if (!this.options.publish(`presentation/led/${screen.role}/display`, payload)) {
        throw new Error(`MQTT 未连接，${screen.role} 未发布`)
      }
    }
  }
}
