/**
 * 双 PPT 合成监控 · 播放端截图上传
 *
 * 联动放映时，主屏(放映运行时)与副屏(/secondary)各自将当前页画面截图，
 * 上传到 /monitor-api/screen/{main|secondary}；服务端合成 1280×800
 * （主屏左 640×800 + 副屏右 640×800，叠加当前页/总页角标）并提供
 * HTTP 下载和 MQTT 发布均由服务端完成，浏览器只负责异步上传截图。
 *
 * 实时性优先：切换页面永远优先于截图——截图延迟执行、进行中只保留最新一帧，
 * html-to-image 用 pixelRatio 1 控制耗时，绝不阻塞切页。
 *
 * 性能关键点：v3 文稿（整页底图 + GIF 覆盖层）的底图已烘焙 GIF 首帧，
 * 截图时用 filter 跳过 GIF <img>——否则动图（实测最大 134MB）会被完整
 * base64 进 SVG，单次截图耗时 3-5 秒。非 v3 形态（含真实元素的页面）
 * 跳过 GIF 会留空洞，故由调用方按页面形态决定是否启用。
 */
import { toJpeg } from 'html-to-image'

export interface CaptureHalfOptions {
  /** 页面为「整页图片底图 + 纯图片覆盖层」形态（v3）：底图已含 GIF 首帧，截图可跳过 GIF 动图 */
  skipGifOverlays?: boolean
}

interface CaptureRequest {
  role: 'main' | 'secondary'
  el: Element
  page: number
  total: number
  options: CaptureHalfOptions
}

let capturing = false
let pendingRequest: CaptureRequest | null = null
let captureSeq = 0

const isGifImg = (node: HTMLElement) =>
  node instanceof HTMLImageElement && /\.gif(\?|$)/i.test(node.currentSrc || node.getAttribute('src') || '')

/** 监控截图跳过的重资源节点：GIF 图片（v3 底图已烘焙首帧）与视频元素
 *  （html-to-image 无法渲染 <video> 画面，跳过后显示底图烘焙帧） */
const isSkippedOverlay = (node: HTMLElement) => isGifImg(node) || node instanceof HTMLVideoElement

/** 单次截图的软超时：卡死的截图不允许永久冻结上传管线 */
const CAPTURE_TIMEOUT_MS = 12000

export async function captureAndUploadHalf(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
  options: CaptureHalfOptions = {},
): Promise<boolean> {
  if (capturing) {
    // 正在截图中：只记下最新一帧请求，当前完成后补拍一次
    pendingRequest = { role, el, page, total, options }
    return true
  }
  capturing = true
  const seq = ++captureSeq
  try {
    return await Promise.race([
      doCapture(role, el, page, total, options, seq),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), CAPTURE_TIMEOUT_MS)),
    ])
  }
  finally {
    capturing = false
    const next = pendingRequest
    pendingRequest = null
    if (next) void captureAndUploadHalf(next.role, next.el, next.page, next.total, next.options)
  }
}

async function doCapture(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
  options: CaptureHalfOptions,
  seq: number,
): Promise<boolean> {
  try {
    // 监控板只需 640×800 半区；JPEG 比 PNG 小得多，避免大截图占满浏览器/局域网队列。
    // v3 页面跳过 GIF 覆盖层（底图已烘焙首帧），避免动图字节进 SVG。
    const dataUrl = await toJpeg(el as HTMLElement, {
      pixelRatio: 0.65,
      quality: 0.78,
      backgroundColor: '#101522',
      ...(options.skipGifOverlays ? { filter: (node: HTMLElement) => !isSkippedOverlay(node) } : {}),
    })
    // 超时后被放弃的迟到截图不再上传，防止旧画面覆盖新画面
    if (seq !== captureSeq) return false
    const response = await fetch(`/monitor-api/screen/${role}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, total, image: dataUrl }),
    })
    if (!response.ok) return false
    // 服务端对每次合成使用 revision 专属 URL，并统一以 QoS 1/retain 推送 MQTT；
    // 不能由主屏浏览器单独发布，否则副屏晚到的合成帧会没有通知。
    await response.json()
    return true
  }
  catch {
    return false
  }
}

/** v3 页面形态判定：整页图片底图 + 元素全为图片/视频（GIF 或转码视频覆盖层），
 *  覆盖层首帧已烘焙进底图（转码视频带 poster），可安全跳过/驻留 */
export function isBakedImagePage(slide: { background?: { type?: string } | null; elements?: Array<{ type?: string }> } | null | undefined): boolean {
  if (!slide || slide.background?.type !== 'image') return false
  const elements = slide.elements || []
  return elements.every(el => el.type === 'image' || el.type === 'video')
}
