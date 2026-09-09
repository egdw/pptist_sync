/**
 * 页面图片导出：将 PPTist 页面离屏渲染为整页 PNG（主屏 v3 资源化上传专用）。
 *
 * 用 PPTist 自身的 ThumbnailSlide 静态渲染器（与编辑器缩略图同一组件）离屏挂载，
 * html-to-image 导出——静态内容保真度与编辑器缩略图一致，GIF 以首帧烘焙进底图，
 * 播放时由真实 GIF <img> 原位覆盖实现动画。
 */
import { createApp, computed, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { toPng } from 'html-to-image'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import { injectKeySlideScale } from '@/types/injectKey'
import { useSlidesStore } from '@/store'
import type { Slide } from '@/types/slides'

const RENDER_WIDTH = 1600

/** 等待字体与图片资源就绪（首帧渲染保真） */
async function waitAssetsReady(): Promise<void> {
  try { await (document as Document & { fonts?: FontFaceSet }).fonts?.ready } catch { /* 忽略 */ }
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

// 1x1 透明占位：资源缺失/无法嵌入时使用，避免 html-to-image 因取不到图而整体失败
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** 剔除解析产物中的空图片元素：pptxtojson 对提取失败的图片给出空 base64，
 *  <img src=""> 会被浏览器解析为当前页面 URL，html-to-image 嵌图时会把整页 HTML 当图片拉取导致失败 */
function sanitizeSlide(slide: Slide): Slide {
  const cleaned: Slide = { ...slide }
  if (Array.isArray(slide.elements)) {
    cleaned.elements = slide.elements.filter(el => {
      if (el.type === 'image') return !!el.src
      return true
    }) as Slide['elements']
  }
  return cleaned
}

/** 渲染单页为 PNG dataURL（调用方负责提供页面所在的 Pinia 上下文数据） */
export async function renderSlideToPngDataUrl(
  slide: Slide,
  viewportSize: number,
  viewportRatio: number,
  width = RENDER_WIDTH,
): Promise<string> {
  const safeSlide = sanitizeSlide(slide)
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;margin:0;padding:0;'
  document.body.appendChild(host)

  const pinia = createPinia()
  const app = createApp({
    setup() {
      // ThumbnailSlide 依赖全局 slides store 的视口尺寸；用导入文稿的实际比例
      const store = useSlidesStore(pinia)
      store.setViewportSize(viewportSize)
      store.setViewportRatio(viewportRatio)
      const scale = computed(() => width / viewportSize)
      app.provide(injectKeySlideScale, scale)
      return () => h(ThumbnailSlide, { slide: safeSlide, size: width, visible: true })
    },
  })
  app.use(pinia)
  app.mount(host)

  try {
    await nextTick()
    await waitAssetsReady()
    const node = host.firstElementChild as HTMLElement
    if (!node) throw new Error('页面渲染失败')
    return await toPng(node, { pixelRatio: 1, imagePlaceholder: PLACEHOLDER })
  }
  finally {
    app.unmount()
    host.remove()
  }
}

/** dataURL → Blob */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const head = dataUrl.slice(0, comma)
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'image/png'
  const base64 = dataUrl.slice(comma + 1)
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
