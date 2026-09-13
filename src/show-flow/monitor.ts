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
 * 性能关键点：GIF <img> 与 <video> 一律从截图中过滤（isSkippedOverlay）——
 * 否则动图（实测最大 134MB）会被完整 base64 进 SVG，把渲染主线程阻塞
 * 数十秒（RK3588 整机假死实测触发器）。v3 页面底图已烘焙 GIF 首帧，
 * 过滤后视觉无损；混合页面在监控板上留空洞，可接受。
 */
import { toJpeg } from 'html-to-image'

interface CaptureRequest {
  role: 'main' | 'secondary'
  el: Element
  page: number
  total: number
}

let inflight: Promise<unknown> | null = null
let pendingRequest: CaptureRequest | null = null
let captureSeq = 0

const isGifImg = (node: HTMLElement) =>
  node instanceof HTMLImageElement && /\.gif(\?|$)/i.test(node.currentSrc || node.getAttribute('src') || '')

/** 监控截图跳过的重资源节点：GIF 图片与视频元素。
 *  GIF 一律跳过（不再限于 v3 baked 页面）：监控板是 0.65 倍缩略图，不需要动图；
 *  把大 GIF base64 进 SVG 会把渲染主线程阻塞数十秒——RK3588 上正是
 *  "网页无响应→整机假死"的直接触发器之一。v3 页面底图已烘焙 GIF 首帧，视觉无损。 */
const isSkippedOverlay = (node: HTMLElement) => isGifImg(node) || node instanceof HTMLVideoElement

/** 单次截图的软超时：超时只放弃"等待结果"，绝不并发叠加新的截图
 *  （html-to-image 无法真正取消，叠加并发会放大主线程阻塞与内存峰值） */
const CAPTURE_TIMEOUT_MS = 12000

export async function captureAndUploadHalf(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
): Promise<boolean> {
  // 真单飞：上一张（即使已超时被放弃）未真正结束前，只保留最新一帧请求
  if (inflight) {
    pendingRequest = { role, el, page, total }
    return true
  }
  const seq = ++captureSeq
  const task = doCapture(role, el, page, total, seq)
  inflight = task
  void task.finally(() => {
    inflight = null
    const next = pendingRequest
    pendingRequest = null
    if (next) void captureAndUploadHalf(next.role, next.el, next.page, next.total)
  })
  return Promise.race([
    task.catch(() => false),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), CAPTURE_TIMEOUT_MS)),
  ])
}

async function doCapture(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
  seq: number,
): Promise<boolean> {
  try {
    // 监控板只需 640×800 半区；JPEG 比 PNG 小得多，避免大截图占满浏览器/局域网队列。
    // GIF/视频覆盖层一律过滤（isSkippedOverlay），杜绝大动图进 SVG 序列化
    const dataUrl = await toJpeg(el as HTMLElement, {
      pixelRatio: 0.65,
      quality: 0.78,
      backgroundColor: '#101522',
      filter: (node: HTMLElement) => !isSkippedOverlay(node),
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
