/**
 * PPTist 主屏适配器：直接驱动本地 slidesStore。
 * gotoById 严格满足 ACK 前置条件：currentSlideIndex 更新 → nextTick → 至少一帧渲染。
 */
import { nextTick } from 'vue'
import { useSlidesStore } from '@/store'
import { buildPptistManifest } from '../manifest'
import type { PageManifest, ScreenAdapter } from '../types'

function raf(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

export class PptistScreenAdapter implements ScreenAdapter {
  /** 已执行过的 commandId 去重缓存（幂等） */
  private executedCommandIds = new Set<string>()
  private currentPageId: string | null = null

  async getManifest(): Promise<PageManifest[]> {
    return buildPptistManifest(useSlidesStore().slides)
  }

  async gotoById(pageId: string, commandId: string): Promise<void> {
    if (this.executedCommandIds.has(commandId)) return
    this.executedCommandIds.add(commandId)
    if (this.executedCommandIds.size > 64) {
      const first = this.executedCommandIds.values().next().value
      if (first) this.executedCommandIds.delete(first)
    }

    const slidesStore = useSlidesStore()
    const index = slidesStore.slides.findIndex(slide => slide.id === pageId)
    if (index === -1) throw new Error(`[ShowFlow] 主屏页面不存在: ${pageId}`)
    if (slidesStore.slides[slidesStore.slideIndex]?.id === pageId) {
      this.currentPageId = pageId
      return // 目标即当前页，仍视为切换完成
    }

    slidesStore.updateSlideIndex(index)
    await nextTick()
    await raf()
    this.currentPageId = pageId
  }

  getCurrentPageId(): string | null {
    const slidesStore = useSlidesStore()
    return slidesStore.slides[slidesStore.slideIndex]?.id ?? this.currentPageId
  }

  async refresh(): Promise<void> { /* manifest 实时来自 store，无需处理 */ }
}
