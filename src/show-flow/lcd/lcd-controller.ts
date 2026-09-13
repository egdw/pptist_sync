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
  private request = 0
  /** pageId → 已发布画面指纹（内容寻址 sha 集）；重访相同画面完全跳过渲染与发布 */
  private shaKeyByPage = new Map<string, string>()
  private lastPublishedKey = ''
  constructor(private options: LcdControllerOptions) {}

  applyPage(pageId: string | null, force = false): Promise<void> {
    if (!pageId || !this.options.getPage(pageId)?.lcd) return this.queue
    const request = ++this.request
    this.queue = this.queue.then(() => request === this.request ? this.apply(pageId, force, request) : undefined).catch(error => {
      console.error('[ShowFlow LCD] LCD 配置应用失败', error)
      this.options.onNotice?.(`LCD 配置应用失败：${error instanceof Error ? error.message : error}`, 'error')
    })
    return this.queue
  }

  private async apply(pageId: string | null, force: boolean, request: number) {
    if (!pageId || (!force && pageId === this.lastPageId)) return
    const page = this.options.getPage(pageId)
    if (!page?.lcd) return // 没有 LCD 块：严格保持上一状态，不发布
    // 内容去重：该页上次发布的画面与当前 LCD 显示一致时，跳过渲染与发布
    //（后退/重访步骤不再重复渲染，板端也不重复接收/下载）
    const cachedKey = this.shaKeyByPage.get(pageId)
    if (cachedKey && cachedKey === this.lastPublishedKey) {
      this.lastPageId = pageId
      return
    }
    const result = await renderLcdState(page.lcd, { publish: true })
    if (request !== this.request) return
    const shaKey = result.screens.map(screen => `${screen.role}:${screen.sha256}`).join('|')
    // 服务端代发布（qos1+retain+失败重试）；服务端无 MQTT 配置时回退浏览器通道（带重试）
    // true=已送达; 'queued'=服务端 MQTT 掉线排队重试(补偿送达, 勿重复发布)
    let published = result.published === true || result.published === 'queued'
    if (!published) published = await this.publishWithRetry(result)
    if (!published) throw new Error('MQTT 未连接且重试失败，LCD 画面未更新')
    this.shaKeyByPage.set(pageId, shaKey)
    this.lastPublishedKey = shaKey
    this.lastPageId = pageId
    this.options.onNotice?.(`LCD 已更新（revision ${result.revision}${result.published ? '，服务端下发' : ''}）`, 'success')
  }

  /** 浏览器通道兜底：三次指数退避重试，覆盖服务端 MQTT 未配置/掉线场景 */
  private async publishWithRetry(result: LedRenderResult): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 600 * 2 ** (attempt - 1)))
      const sent = publishLcdRenderResult(result, this.options.publish)
      if (sent === result.screens.length) return true
    }
    return false
  }
}
