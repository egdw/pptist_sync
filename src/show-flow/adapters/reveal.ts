/**
 * Reveal / Markdown 副屏适配器。
 *
 * Manifest：从服务端静态路径拉取 markdown 文本并本地解析（编辑期使用）。
 * gotoById：通过注入的 transport 发送 NAVIGATE 给 reveal 播放页（reveal 页内
 * 负责幂等去重、切换渲染与 ACK 回发——ACK 由 Controller 统一聚合）。
 */
import type { PageManifest, ScreenAdapter, ScreenRole } from '../types'
import { parseMarkdownManifest, markdownManifestVersion } from '../manifest'

export interface ShowFlowTransport {
  /** 向指定 role 的远程播放端发送协议消息（经 WS 服务器路由） */
  sendToRole(role: ScreenRole, message: Record<string, unknown>): void
}

export class RevealMarkdownScreenAdapter implements ScreenAdapter {
  private mdCache: { version: string; manifest: PageManifest[] } | null = null
  private executing = new Set<string>()

  constructor(
    public mdPath: string,
    private transport: ShowFlowTransport,
  ) {}

  async refresh(): Promise<void> {
    this.mdCache = null
    await this.getManifest()
  }

  async getManifest(): Promise<PageManifest[]> {
    if (this.mdCache) return this.mdCache.manifest
    const md = await this.fetchMarkdown()
    this.mdCache = {
      version: markdownManifestVersion(md),
      manifest: parseMarkdownManifest(md),
    }
    return this.mdCache.manifest
  }

  async getManifestVersion(): Promise<string> {
    if (!this.mdCache) await this.getManifest()
    return this.mdCache!.version
  }

  private async fetchMarkdown(): Promise<string> {
    const res = await fetch(this.mdPath, { cache: 'no-store' })
    if (!res.ok) throw new Error(`[ShowFlow] 无法加载副屏 Markdown: ${this.mdPath} (${res.status})`)
    return res.text()
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
      role: 'secondary',
    })
    // ACK 到达时间由 Controller 通过 websocket 消息感知，这里不等待
  }

  getCurrentPageId(): string | null {
    // 副屏真实页码以 Controller 维护的快照为准，适配器不猜测
    return null
  }
}
