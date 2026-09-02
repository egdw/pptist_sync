/**
 * 「默认 PPT」服务端 API 客户端
 *
 * 全部使用同源相对路径（/default-ppt-api/*）：
 * - 开发模式经 Vite 代理转发到本地轻量服务端；
 * - 生产模式由 server/pptist-server.mjs 同端口提供；
 * 不硬编码任何 IP / 端口，局域网内其他电脑通过服务器地址访问时同样可用。
 */
import { useSlidesStore } from '@/store'
import type { Slide, SlideTheme } from '@/types/slides'

export interface DefaultPptMeta {
  exists: boolean
  seq?: number
  version?: string
  filename?: string
  pageCount?: number
  updatedAt?: string
}

export interface DefaultPptConfig {
  publicBaseUrl: string | null
  maxUploadMB: number
  acceptTypes: string[]
  /** 服务端支持的上传信封协议版本；旧版服务端不返回该字段 */
  uploadEnvelope?: number
}

export interface DefaultPptBundle {
  title?: string
  slides: Slide[]
  theme?: Partial<SlideTheme>
  viewportSize?: number
  viewportRatio?: number
}

export interface UploadResult extends DefaultPptMeta {
  ok: boolean
  error?: string
}

const API_BASE = '/default-ppt-api'

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((data && (data as { error?: string }).error) || `请求失败（${response.status}）`)
  }
  return data as T
}

export function fetchDefaultPptConfig(): Promise<DefaultPptConfig> {
  return requestJson(`${API_BASE}/config`)
}

export function fetchDefaultPptCurrent(): Promise<DefaultPptMeta> {
  return requestJson(`${API_BASE}/current`)
}

/** 获取当前版本的解析数据；同时返回服务端实际提供的版本号（响应头），避免请求期间版本切换导致的错配 */
export async function fetchDefaultPptSlides(): Promise<{ bundle: DefaultPptBundle; version: string; seq: number }> {
  const response = await fetch(`${API_BASE}/current/slides`, { cache: 'no-store' })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error((data && (data as { error?: string }).error) || `获取默认 PPT 失败（${response.status}）`)
  }
  const bundle = await response.json() as DefaultPptBundle
  const version = response.headers.get('X-PPTist-Version') || ''
  const seq = Number((version.match(/^v(\d+)$/) || [])[1] || 0)
  return { bundle, version, seq }
}

/**
 * 上传并设为默认：二进制信封 v2 请求体
 *   [4 字节头长度][4 字节 bundle 长度][头部 JSON{filename,pageCount}][bundle 字节][原始文件字节]
 * - 文件不做 base64 膨胀；bundle（解析后的文稿 JSON）按页分片序列化后组装为 Blob，
 *   全程不产生超大字符串，支持大文件（上限内）上传。
 * - 服务端按字节范围原样保存 bundle，保证「原文件、解析数据同一版本」。
 * - onProgress 回调上报上传进度（0-100）。
 */
export function uploadDefaultPpt(
  payload: { filename: string; file: File; pageCount: number; bundleParts: BlobPart[] },
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const bundleBlob = new Blob(payload.bundleParts)
    const headerBytes = new TextEncoder().encode(JSON.stringify({
      filename: payload.filename,
      pageCount: payload.pageCount,
    }))
    const envelopeParts: BlobPart[] = []
    const headerLen = new ArrayBuffer(4)
    new DataView(headerLen).setUint32(0, headerBytes.length, false)
    const bundleLen = new ArrayBuffer(4)
    new DataView(bundleLen).setUint32(0, bundleBlob.size, false)
    envelopeParts.push(headerLen, bundleLen, headerBytes, bundleBlob, payload.file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/upload`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
    }
    xhr.onload = () => {
      let data: UploadResult | null = null
      try {
        data = JSON.parse(xhr.responseText)
      }
      catch {
        /* 非 JSON 响应 */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) resolve(data)
      else reject(new Error(data?.error || `上传失败（${xhr.status}）`))
    }
    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.send(new Blob(envelopeParts))
  })
}

export interface DefaultPptEventHandlers {
  /** 收到版本通知（含连接建立时的当前版本） */
  onVersion: (meta: DefaultPptMeta) => void
  /** 通知通道（重新）连接成功：调用方应核对服务端当前版本，补上断线期间错过的更新 */
  onOpen?: () => void
}

/**
 * 订阅服务端 SSE 版本通知。
 * EventSource 断线后浏览器会自动重连；onOpen 中需要重新核对当前版本。
 * 返回取消订阅函数。
 */
export function subscribeDefaultPptEvents(handlers: DefaultPptEventHandlers): () => void {
  const source = new EventSource(`${API_BASE}/events`)
  source.addEventListener('version', event => {
    try {
      handlers.onVersion(JSON.parse((event as MessageEvent).data))
    }
    catch {
      /* 忽略无法解析的通知 */
    }
  })
  source.onopen = () => handlers.onOpen?.()
  return () => source.close()
}

/** file → base64（不含 data: 前缀） */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 将默认文稿数据应用到幻灯片 store（播放页与编辑器共用，保证两边是同一份内容） */
export function applyBundleToSlidesStore(bundle: DefaultPptBundle) {
  const slidesStore = useSlidesStore()
  slidesStore.setTheme(bundle.theme || {})
  if (bundle.viewportSize) slidesStore.setViewportSize(bundle.viewportSize)
  if (bundle.viewportRatio) slidesStore.setViewportRatio(bundle.viewportRatio)
  if (bundle.title) slidesStore.setTitle(bundle.title)
  slidesStore.setSlides(bundle.slides)
}
