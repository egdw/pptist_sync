import { nanoid } from 'nanoid'
import type { LcdSceneState, PageManifest } from '../types'
import { renderLcdState, type LedRenderResult } from './render-client'

export interface LcdControllerOptions {
  getPage: (pageId: string) => PageManifest | undefined
  publish: (topic: string, payload: unknown) => boolean
  onNotice?: (text: string, type?: 'info' | 'warning' | 'error' | 'success') => void
}

/** Controller-owned fixed display protocol; Studio test display reuses this path instead of constructing MQTT payloads. */
export function publishLcdRenderResult(result: LedRenderResult, publish: (topic: string, payload: unknown) => boolean): number {
  let sent = 0
  for (const screen of result.screens) {
    const payload = {
      protocol: 'led-display/1.0', type: 'display', msg_id: nanoid(8),
      revision: result.revision, role: screen.role,
      image: { url: screen.url, format: screen.format, width: screen.width, height: screen.height, sha256: screen.sha256 },
    }
    if (publish(`presentation/led/${screen.role}/display`, payload)) sent++
  }
  return sent
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
    const sent = publishLcdRenderResult(result, this.options.publish)
    if (sent !== result.screens.length) throw new Error(`MQTT 未连接，仅发布 ${sent}/${result.screens.length}`)
  }
}
