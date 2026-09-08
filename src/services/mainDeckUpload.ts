/**
 * 主屏文稿 v3 资源化上传（大文件丝滑上传的核心）。
 *
 * 输入：解析后的 slides（图片 src 为 blob: objectURL，来自 pptxtojson blob 模式或 PDF 页 canvas）
 * 流程：创建会话 → 逐资产上传（服务端流式落盘并计算 SHA256 命名，重复字节秒传跳过）
 *       → 原始文件流式上传 → 轻结构 bundle（src 已全部替换为 /default-ppt-api/assets/ URL）→ 原子 commit
 * 特性：
 * - 浏览器峰值内存 ≈ 单个最大资产大小（逐资产获取字节，上传后释放并 revoke）
 * - 资产去重：本地 blob URL 去重 + 服务端内容寻址秒传
 * - 哈希全部由服务端流式计算（局域网 http 环境无 crypto.subtle 依赖）
 * - 失败自动清理会话；commit 前旧版本完全不受影响
 */
import type { Slide, SlideTheme } from '@/types/slides'

const API = '/default-ppt-api'

export interface MainDeckUploadProgress {
  (info: { phase: 'assets' | 'raw' | 'bundle' | 'commit'; done: number; total: number; detail?: string }): void
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
}

/** 深度遍历 slides 中所有可上传媒体引用（元素 src / 背景图等一切字符串 src 字段） */
function walkMediaSources(slides: Slide[], visit: (get: () => string | undefined, set: (v: string) => void) => void) {
  const seen = new Set<unknown>()
  const walkValue = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { value.forEach(walkValue); return }
    const obj = value as Record<string, unknown>
    if (typeof obj.src === 'string') visit(() => obj.src as string | undefined, v => { obj.src = v })
    walkValue(Object.values(obj))
  }
  for (const slide of slides) walkValue(slide)
}

export interface UploadMainDeckV3Options {
  filename: string
  rawFile: File | Blob
  slides: Slide[]
  theme?: Partial<SlideTheme>
  viewportSize?: number
  viewportRatio?: number
  title?: string
  onProgress?: MainDeckUploadProgress
}

export async function uploadMainDeckV3(options: UploadMainDeckV3Options): Promise<{ ok: true; version?: string }> {
  const { filename, rawFile, slides, theme, viewportSize, viewportRatio, title, onProgress } = options

  // 1. 收集全部 blob: 引用（去重）
  const blobUrls = new Set<string>()
  walkMediaSources(slides, get => {
    const src = get()
    if (src && src.startsWith('blob:')) blobUrls.add(src)
  })
  const urlList = [...blobUrls]

  // 2. 创建会话
  const created = await fetch(`${API}/upload-sessions`, { method: 'POST' })
  if (!created.ok) throw new Error(`创建上传会话失败（${created.status}）`)
  const { sessionId } = await created.json() as { sessionId: string }
  const sessionUrl = `${API}/upload-sessions/${sessionId}`

  const cleanupSession = () => { fetch(sessionUrl, { method: 'DELETE' }).catch(() => {}) }

  try {
    // 3. 逐资产上传（顺序执行：峰值内存 ≈ 单个最大资产；相同字节服务端秒传）
    const urlToAsset = new Map<string, string>()
    let uploadedCount = 0
    for (const blobUrl of urlList) {
      const response = await fetch(blobUrl)
      if (!response.ok) throw new Error('读取本地资源失败')
      const blob = await response.blob()
      const ext = EXT_BY_MIME[blob.type] || 'bin'
      const put = await fetch(`${sessionUrl}/assets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Asset-Ext': ext },
        body: blob,
      })
      if (!put.ok) {
        const data = await put.json().catch(() => null)
        throw new Error(`资产上传失败：${data?.error || put.status}`)
      }
      const { name } = await put.json() as { name: string }
      urlToAsset.set(blobUrl, `${API}/assets/${name}`)
      uploadedCount++
      onProgress?.({ phase: 'assets', done: uploadedCount, total: urlList.length })
    }

    // 4. 替换 slides 中的 blob: 引用为资产 URL，并撤销 objectURL
    walkMediaSources(slides, (get, set) => {
      const src = get()
      if (src && src.startsWith('blob:')) {
        const asset = urlToAsset.get(src)
        if (asset) set(asset)
      }
    })
    for (const url of urlList) URL.revokeObjectURL(url)

    // 5. 原始文件流式上传（fetch 以 File/Blob 为 body 时浏览器流式读取，不整体进 JS 堆）
    onProgress?.({ phase: 'raw', done: 0, total: 1, detail: `${(rawFile.size / 1024 / 1024).toFixed(0)}MB` })
    const rawPut = await fetch(`${sessionUrl}/raw`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rawFile,
    })
    if (!rawPut.ok) throw new Error(`原始文件上传失败（${rawPut.status}）`)

    // 6. 轻结构 bundle（src 均为短资产 URL，体积小）
    onProgress?.({ phase: 'bundle', done: 0, total: 1 })
    const bundle = { title, slides, theme, viewportSize, viewportRatio }
    const bundlePut = await fetch(`${sessionUrl}/bundle`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
    })
    if (!bundlePut.ok) throw new Error(`文稿数据上传失败（${bundlePut.status}）`)

    // 7. 原子发布
    onProgress?.({ phase: 'commit', done: 0, total: 1 })
    const commit = await fetch(`${sessionUrl}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, pageCount: slides.length }),
    })
    const result = await commit.json().catch(() => null)
    if (!commit.ok || !result?.ok) throw new Error(result?.error || `发布失败（${commit.status}）`)
    return { ok: true, version: result.version }
  }
  catch (error) {
    cleanupSession()
    throw error
  }
}
