/**
 * 双 PPT 合成监控 · 播放端截图上传
 *
 * 联动放映时，主屏(ShowFlowConsole)与副屏(/secondary)各自将当前页画面截图，
 * 上传到 /monitor-api/screen/{main|secondary}；服务端合成 1280×800
 * （主屏左 640×800 + 副屏右 640×800，叠加当前页/总页角标）并提供
 * HTTP 下载和 MQTT 发布均由服务端完成，浏览器只负责异步上传截图。
 *
 * 实时性优先：切换页面永远优先于截图——截图延迟执行、进行中只保留最新一帧，
 * html-to-image 用 pixelRatio 1 控制耗时，绝不阻塞切页。
 */
import { toJpeg } from 'html-to-image'

let capturing = false
let pendingRequest: { role: 'main' | 'secondary'; el: Element; page: number; total: number } | null = null

export async function captureAndUploadHalf(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
): Promise<boolean> {
  if (capturing) {
    // 正在截图中：只记下最新一帧请求，当前完成后补拍一次
    pendingRequest = { role, el, page, total }
    return true
  }
  capturing = true
  try {
    return await doCapture(role, el, page, total)
  }
  finally {
    capturing = false
    const next = pendingRequest
    pendingRequest = null
    if (next) void captureAndUploadHalf(next.role, next.el, next.page, next.total)
  }
}

async function doCapture(
  role: 'main' | 'secondary',
  el: Element,
  page: number,
  total: number,
): Promise<boolean> {
  try {
    // 监控板只需 640×800 半区；JPEG 比 PNG 小得多，避免大截图占满浏览器/局域网队列。
    const dataUrl = await toJpeg(el as HTMLElement, { pixelRatio: 0.65, quality: 0.78, backgroundColor: '#101522' })
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
