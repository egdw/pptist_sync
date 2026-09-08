/**
 * 远程 PPTist 副屏适配器（双 PPTist 模式中的 PPTist B）。
 *
 * Manifest：来自服务端「默认文稿」上传接口（/default-ppt-api/current/slides），
 * 与 /upload 上传流程共享同一份文档；slideId 为永久 ID。
 * gotoById：通过 transport 向 role=secondary 的播放页（/secondary）发送 NAVIGATE；
 * 切页渲染与 ACK 由播放页内的 SecondaryShowFlowClient 完成。
 */
import type { PageManifest, ScreenAdapter, ScreenRole } from '../types'
import { buildPptistManifest } from '../manifest'
import { fetchSecondaryDocSlides } from '@/services/defaultPpt'
import type { Slide } from '@/types/slides'
import type { ShowFlowTransport } from './reveal'

export class PptistRemoteScreenAdapter implements ScreenAdapter {
  private cache: { version: string; manifest: PageManifest[] } | null = null
  private slides: Slide[] = []
  private executing = new Set<string>()

  constructor(private transport: ShowFlowTransport) {}

  async refresh(): Promise<void> {
    this.cache = null
    await this.getManifest()
  }

  async getManifest(): Promise<PageManifest[]> {
    if (this.cache) return this.cache.manifest
    const { bundle, version } = await fetchSecondaryDocSlides()
    this.slides = bundle.slides
    this.cache = {
      version: `${version}-${bundle.slides.length}`,
      manifest: buildPptistManifest(bundle.slides),
    }
    return this.cache.manifest
  }

  /** 副屏文稿原始 slides（编排页渲染缩略图用） */
  getSlides(): Slide[] {
    return this.slides
  }

  async gotoById(pageId: string, commandId: string): Promise<void> {
    if (this.executing.has(commandId)) return
    this.executing.add(commandId)
    if (this.executing.size > 64) {
      const first = this.executing.values().next().value
      if (first) this.executing.delete(first)
    }
    this.transport.sendToRole('secondary', {
      type: 'NAVIGATE',
      commandId,
      pageId,
      role: 'secondary' as ScreenRole,
    })
  }

  getCurrentPageId(): string | null {
    // 副屏真实页码以 Controller 维护的快照为准，适配器不猜测
    return null
  }
}
