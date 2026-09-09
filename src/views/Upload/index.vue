<template>
  <div class="pptist-upload">
    <div class="header">
      <div class="brand">
        <img class="logo" src="/logo.png" alt="PPTist" />
        <span class="name">上传 / 更换默认 PPT</span>
      </div>
      <div class="links">
        <a class="link" :href="playUrl" target="_blank">打开播放页</a>
        <a class="link" href="/editor" target="_blank">打开编辑器</a>
      </div>
    </div>

    <div class="content">
      <div class="main">
        <div class="card">
          <div class="card-title">选择 PPTX 文件</div>
          <div class="target-row">
            <span class="target-label">上传目标：</span>
            <button class="target-btn" :class="{ active: uploadTarget === 'main' }" @click="uploadTarget = 'main'">主屏文稿</button>
            <button class="target-btn" :class="{ active: uploadTarget === 'secondary' }" @click="uploadTarget = 'secondary'">副屏文稿（PPTist B）</button>
          </div>
          <div class="target-tip">
            {{ uploadTarget === 'secondary'
              ? '副屏文稿与主屏 PPT 完全独立（页数、内容均可不同），供 /secondary 副屏播放页使用。'
              : '主屏文稿用于编辑器与 /play 播放页。' }}
          </div>
          <div
            class="drop-area"
            :class="{ dragging }"
            @click="selectFile()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="handleDrop"
          >
            <i-icon-park-outline:upload class="drop-icon" />
            <div class="drop-text">点击选择或拖入 .pptx / .pdf 文件</div>
            <div class="drop-sub">允许类型：.pptx / .pdf；大小上限：{{ config.maxUploadMB }}MB（PDF 每页将渲染为图片页，页面文字自动提取为备注）</div>
            <input ref="fileInputRef" type="file" accept=".pptx,.pdf" hidden @change="handleFileChange" />
          </div>

          <div class="file-info" v-if="selectedFile">
            <i-icon-park-outline:ppt class="file-icon" />
            <div class="file-text">
              <div class="file-name">{{ selectedFile.name }}</div>
              <div class="file-size">{{ (selectedFile.size / 1024 / 1024).toFixed(2) }} MB</div>
            </div>
          </div>

          <div class="step-status" v-if="statusText">{{ statusText }}</div>
          <div class="progress" v-if="progressVisible">
            <div class="progress-inner" :style="{ width: progressPercent + '%' }"></div>
          </div>
          <div class="error-text" v-if="serverOutdated">
            检测到服务端版本较旧（与页面协议不一致），上传会失败。请用最新部署包中的 server/pptist-server.mjs 覆盖板子上的同名文件，然后执行 ./stop-pptist.sh && ./start-pptist.sh 重启服务。
          </div>
          <div class="error-text" v-else-if="errorText">{{ errorText }}</div>

          <button class="primary-btn" :disabled="!canUpload" @click="upload()">
            <i-icon-park-outline:upload class="btn-icon" /> {{ uploading ? '上传中 ...' : (uploadTarget === 'secondary' ? '上传并设为副屏文稿' : '上传并设为默认') }}
          </button>
          <div class="btn-tip">上传成功后将替换当前{{ uploadTarget === 'secondary' ? '副屏文稿' : '默认 PPT' }}，已打开的{{ uploadTarget === 'secondary' ? '副屏页' : '播放页面' }}会自动切换到新文稿的第一页。</div>
        </div>

        <div class="card" v-if="successText">
          <div class="success-text">
            <i-icon-park-outline:check-one class="success-icon" />
            {{ successText }}
          </div>
        </div>
      </div>

      <div class="side">
        <div class="card">
          <div class="card-title">主屏文稿（默认 PPT）</div>
          <template v-if="currentMeta.exists">
            <div class="meta-row"><span class="meta-label">文件名</span><span class="meta-value">{{ currentMeta.filename }}</span></div>
            <div class="meta-row"><span class="meta-label">页数</span><span class="meta-value">{{ currentMeta.pageCount }}</span></div>
            <div class="meta-row"><span class="meta-label">更新时间</span><span class="meta-value">{{ formatTime(currentMeta.updatedAt) }}</span></div>
            <div class="meta-row"><span class="meta-label">版本</span><span class="meta-value">{{ currentMeta.version }}</span></div>
          </template>
          <div class="empty-meta" v-else>暂无主屏文稿</div>
          <a class="play-link" :href="playUrl" target="_blank"><i-icon-park-outline:play class="btn-icon" /> 打开播放页</a>
        </div>

        <div class="card">
          <div class="card-title">副屏文稿（PPTist B）</div>
          <template v-if="secondaryMeta.exists">
            <div class="meta-row"><span class="meta-label">文件名</span><span class="meta-value">{{ secondaryMeta.filename }}</span></div>
            <div class="meta-row"><span class="meta-label">页数</span><span class="meta-value">{{ secondaryMeta.pageCount }}</span></div>
            <div class="meta-row"><span class="meta-label">更新时间</span><span class="meta-value">{{ formatTime(secondaryMeta.updatedAt) }}</span></div>
            <div class="meta-row"><span class="meta-label">版本</span><span class="meta-value">{{ secondaryMeta.version }}</span></div>
          </template>
          <div class="empty-meta" v-else>暂无副屏文稿（与主屏完全独立）</div>
          <a class="play-link" :href="secondaryUrl" target="_blank"><i-icon-park-outline:play class="btn-icon" /> 打开副屏页 /secondary</a>
        </div>

        <div class="card">
          <div class="card-title">远程上传地址</div>
          <div class="address-row">
            <span class="address">{{ uploadUrl }}</span>
            <button class="mini-btn" @click="copyUploadUrl()">复制地址</button>
          </div>
          <div class="warn-text" v-if="isLocalAddress">当前通过 {{ hostname }} 访问，该地址仅本机可用；请在其他电脑上使用服务器的局域网 IP 访问。</div>
          <div class="steps">在同一局域网的电脑上打开此地址 → 选择 PPTX → 上传并设为默认</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { nanoid } from 'nanoid'
import { useSlidesStore } from '@/store'
import useImport from '@/hooks/useImport'
import {
  fetchDefaultPptConfig,
  fetchDefaultPptCurrent,
  fetchSecondaryDocCurrent,
  subscribeDefaultPptEvents,
  subscribeSecondaryDocEvents,
  uploadDefaultPpt,
  type DefaultPptBundle,
  type DefaultPptConfig,
  type DefaultPptMeta,
} from '@/services/defaultPpt'
import { renderSlideToPngDataUrl, dataUrlToBlob } from '@/services/pageImageExport'
import type { PPTImageElement } from '@/types/slides'
import { copyText } from '@/utils/clipboard'
import message from '@/utils/message'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const slidesStore = useSlidesStore()
const { slides } = storeToRefs(slidesStore)
const { importPPTXFile, exporting } = useImport()

const config = ref<DefaultPptConfig>({ publicBaseUrl: null, maxUploadMB: 1024, acceptTypes: ['.pptx', '.pdf'] })
const currentMeta = ref<DefaultPptMeta>({ exists: false })
const secondaryMeta = ref<DefaultPptMeta>({ exists: false })
// 上传目标槽位：主屏文稿（默认 PPT）或副屏文稿（PPTist B），两槽位存储互相独立
const uploadTarget = ref<'main' | 'secondary'>('main')
const selectedFile = ref<File | null>(null)
const parsed = ref(false)
const parsing = ref(false)
const uploading = ref(false)
const statusText = ref('')
const errorText = ref('')
const successText = ref('')
const progressPercent = ref(0)
const dragging = ref(false)
// 解析产物：按页分片的 bundle BlobPart（避免超大 JSON 字符串）与页数
const parsedBundleParts = ref<BlobPart[] | null>(null)
const parsedPageCount = ref(0)
// 主屏 v3 解析产物：轻结构快照（src 为 blob: URL），上传阶段逐资产化
const parsedV3 = ref<{
  slides: DefaultPptBundle['slides']
  theme: Partial<DefaultPptBundle['theme']> | undefined
  viewportSize?: number
  viewportRatio?: number
  title?: string
} | null>(null)
// 解析前播种的空页 id：导入完成后 store 中仍只有该页，说明解析失败
let seedSlideId = ''

const fileInputRef = ref<HTMLInputElement | null>(null)
let unsubscribe: (() => void) | null = null

const hostname = computed(() => window.location.hostname)
const isLocalAddress = computed(() => ['localhost', '127.0.0.1', '[::1]'].includes(hostname.value))
const uploadUrl = computed(() => {
  const base = (config.value.publicBaseUrl || window.location.origin).replace(/\/+$/, '')
  return `${base}/upload`
})
const playUrl = computed(() => {
  const base = (config.value.publicBaseUrl || window.location.origin).replace(/\/+$/, '')
  return `${base}/play`
})
const secondaryUrl = computed(() => {
  const base = (config.value.publicBaseUrl || window.location.origin).replace(/\/+$/, '')
  // 不带尾斜杠：相对路径资源在 /secondary/ 子路径下会 404
  return `${base}/secondary`
})

const progressVisible = computed(() => uploading.value || parsing.value)
// 页面（二进制信封 v2）与服务端版本不一致时（旧版服务端无 uploadEnvelope 字段），
// 上传必然失败且报错难以理解，直接阻断并明确提示
const configFetched = ref(false)
const serverOutdated = computed(() => configFetched.value && config.value.uploadEnvelope !== 2)
const canUpload = computed(() => !!selectedFile.value && parsed.value && !uploading.value && !serverOutdated.value)

const formatTime = (time?: string) => {
  if (!time) return '—'
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? time : date.toLocaleString('zh-CN', { hour12: false })
}

const selectFile = () => fileInputRef.value?.click()

const isPdf = (file: File) => /\.pdf$/i.test(file.name)

const validateFile = (file: File): string | null => {
  if (!/\.(pptx|pdf)$/i.test(file.name)) return '仅支持 .pptx / .pdf 文件'
  if (file.size > config.value.maxUploadMB * 1024 * 1024) return `文件超过大小上限（${config.value.maxUploadMB}MB）`
  if (file.size === 0) return '文件内容为空'
  return null
}

const resetParseState = () => {
  parsed.value = false
  parsedBundleParts.value = null
  parsedV3.value = null
  parsedPageCount.value = 0
  errorText.value = ''
  successText.value = ''
  progressPercent.value = 0
}

/** 按页分片序列化 bundle：避免为整个文稿生成超大 JSON 字符串（支持大文件上传） */
const buildBundleParts = (bundle: DefaultPptBundle): BlobPart[] => {
  const parts: BlobPart[] = [
    `{"title":${JSON.stringify(bundle.title || '')},"theme":${JSON.stringify(bundle.theme || {})},"viewportSize":${bundle.viewportSize || 1000},"viewportRatio":${bundle.viewportRatio || 0.5625},"slides":[`,
  ]
  bundle.slides.forEach((slide, index) => {
    parts.push((index > 0 ? ',' : '') + JSON.stringify(slide))
  })
  parts.push(']}')
  return parts
}

/** PDF：pdf.js 逐页渲染为图片页（每页背景图铺满），页面文字提取到演讲者备注。
 *  main 目标用 toBlob + objectURL（v3 资产化上传，峰值内存 ≈ 单页）；secondary 保持 dataURL（旧信封协议）。 */
const parsePdf = async (file: File, opts: { blobSrc?: boolean } = {}): Promise<DefaultPptBundle> => {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const slides: DefaultPptBundle['slides'] = []
  let viewportRatio = 0.5625

  for (let i = 1; i <= pdf.numPages; i++) {
    statusText.value = `解析中（PDF 第 ${i}/${pdf.numPages} 页）...`
    const page = await pdf.getPage(i)
    const baseViewport = page.getViewport({ scale: 1 })
    if (i === 1 && baseViewport.width > 0) {
      viewportRatio = baseViewport.height / baseViewport.width
    }
    const scale = Math.min(1920 / baseViewport.width, 4)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器不支持 Canvas 渲染')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: context, viewport }).promise

    let src = ''
    if (opts.blobSrc) {
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('页面导出失败')), 'image/jpeg', 0.9)
      })
      src = URL.createObjectURL(blob)
    }
    else src = canvas.toDataURL('image/jpeg', 0.9)

    let remark = ''
    try {
      const textContent = await page.getTextContent()
      const lines = textContent.items
        .map(item => ('str' in item ? item.str : ''))
        .join('')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      remark = lines.join('\n')
    }
    catch { /* 文字提取失败不影响页面 */ }

    slides.push({
      id: nanoid(10),
      elements: [],
      background: { type: 'image', image: { src, size: 'cover' } },
      remark,
    })
    page.cleanup()
    // 释放本页 Canvas（v3 模式下页面字节已进入 Blob 存储，画布可立即回收）
    canvas.width = 0
    canvas.height = 0
  }

  if (!slides.length) throw new Error('PDF 没有可显示的页面')
  return {
    title: file.name.replace(/\.pdf$/i, ''),
    slides,
    theme: {},
    viewportSize: 1000,
    viewportRatio,
  }
}

const handleFile = async (file: File) => {
  const invalid = validateFile(file)
  if (invalid) {
    errorText.value = invalid
    selectedFile.value = null
    return
  }
  selectedFile.value = file
  resetParseState()
  parsing.value = true

  if (isPdf(file)) {
    statusText.value = '解析中 ...'
    try {
      const bundle = await parsePdf(file, { blobSrc: uploadTarget.value === 'main' })
      if (uploadTarget.value === 'main') {
        // v3：保留 blob URL 引用结构，上传时逐资产化，不在解析阶段生成巨型 JSON
        parsedV3.value = {
          slides: bundle.slides,
          theme: bundle.theme || {},
          viewportSize: bundle.viewportSize,
          viewportRatio: bundle.viewportRatio,
          title: bundle.title,
        }
      }
      else {
        parsedBundleParts.value = buildBundleParts(bundle)
      }
      parsedPageCount.value = bundle.slides.length
      parsed.value = true
      statusText.value = `解析成功：共 ${bundle.slides.length} 页，可以上传`
    }
    catch (error) {
      errorText.value = `PDF 解析失败：${(error as Error)?.message || '未知错误'}（加密 PDF 不支持，请先解除密码）`
      statusText.value = ''
    }
    finally {
      parsing.value = false
    }
    return
  }

  // PPTX：解析前重置为单页空文稿，复用现有导入管线（结果写入本地 store，本页不进入放映、不发送放映事件）
  statusText.value = '解析中 ...'
  seedSlideId = nanoid(10)
  slidesStore.setSlides([{ id: seedSlideId, elements: [] }])
  slidesStore.updateSlideIndex(0)
  // 主屏走 v3 资源化：blob 模式解析（图片为 objectURL，避免整份 base64 字符串）
  importPPTXFile([file], { imageMode: uploadTarget.value === 'main' ? 'blob' : 'base64' })
}

const handleFileChange = (e: Event) => {
  const files = (e.target as HTMLInputElement).files
  if (files && files[0]) handleFile(files[0])
  ;(e.target as HTMLInputElement).value = ''
}

const handleDrop = (e: DragEvent) => {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) handleFile(file)
}

// PPTX 现有导入流程无完成回调，通过 exporting 状态判断解析结束
watch(exporting, value => {
  if (value || !selectedFile.value || !parsing.value) return
  parsing.value = false

  const resultSlides = slides.value
  const isSeedUntouched = resultSlides.length === 1 && resultSlides[0].id === seedSlideId
  if (isSeedUntouched || !resultSlides.length) {
    // 解析失败（useImport 内部已提示原因），旧默认 PPT 不受影响
    errorText.value = errorText.value || '解析失败：无法正确读取该文件，请确认文件未损坏后重试'
    statusText.value = ''
    parsed.value = false
    return
  }
  if (uploadTarget.value === 'main') {
    // v3：结构快照（src 为短 blob: URL 字符串，体积小），上传阶段逐资产化
    parsedV3.value = {
      slides: JSON.parse(JSON.stringify(resultSlides)),
      theme: slidesStore.theme,
      viewportSize: slidesStore.viewportSize,
      viewportRatio: slidesStore.viewportRatio,
      title: slidesStore.title,
    }
  }
  else {
    parsedBundleParts.value = buildBundleParts({
      title: slidesStore.title,
      slides: resultSlides,
      theme: slidesStore.theme,
      viewportSize: slidesStore.viewportSize,
      viewportRatio: slidesStore.viewportRatio,
    })
  }
  parsedPageCount.value = resultSlides.length
  parsed.value = true
  statusText.value = `解析成功：共 ${resultSlides.length} 页，可以上传`
})

/** 主屏 v3 上传：逐页渲染为整页图片资产，GIF 图片保留为动图覆盖层 */
const API = '/default-ppt-api'
const pagesCount = computed(() => parsedV3.value?.slides.length || parsedPageCount.value)

const prepareMainDeckV3 = async (sessionId: string) => {
  const v3 = parsedV3.value
  if (!v3) throw new Error('解析数据缺失')
  const viewportSize = v3.viewportSize || slidesStore.viewportSize
  const viewportRatio = v3.viewportRatio || slidesStore.viewportRatio
  const sessionUrl = `${API}/upload-sessions/${sessionId}`
  const total = v3.slides.length

  // 跨页面共享去重：同一图片（同一 blob URL）可能被多个元素/多页复用，
  // 上传一次映射为资产 URL；全部页面处理完后统一 revoke（提前 revoke 会让后续元素 fetch 失败）
  const gifAssetByUrl = new Map<string, string>()
  const allBlobUrls = new Set<string>()

  for (let i = 0; i < total; i++) {
    const slide = v3.slides[i]
    statusText.value = `生成页面图片（${i + 1}/${total}）...`
    progressPercent.value = Math.round((i / total) * 70)

    // 1. 整页离屏渲染为 PNG（全部静态内容含 GIF 首帧烘焙进底图；空 src 图片元素已剔除）
    const pngDataUrl = await renderSlideToPngDataUrl(slide, viewportSize, viewportRatio)
    const pagePut = await fetch(`${sessionUrl}/assets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'X-Asset-Ext': 'png' },
      body: dataUrlToBlob(pngDataUrl),
    })
    if (!pagePut.ok) throw new Error(`页面图片上传失败（${pagePut.status}）`)
    const pageAsset = (await pagePut.json()).name

    // 2. GIF 元素：字节原样上传为动图资产（去重），作为唯一保留的「活」元素；
    //    其余元素（文本/形状/静态图）已烘焙进底图，从活元素中移除避免双重渲染
    const overlays: PPTImageElement[] = []
    for (const el of slide.elements) {
      if (el.type !== 'image' || !el.src?.startsWith('blob:')) continue
      allBlobUrls.add(el.src)
      let assetUrl = gifAssetByUrl.get(el.src)
      if (!assetUrl) {
        const blob = await (await fetch(el.src)).blob()
        if (blob.type !== 'image/gif') continue // 静态图：已烘焙
        const gifPut = await fetch(`${sessionUrl}/assets`, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/gif', 'X-Asset-Ext': 'gif' },
          body: blob,
        })
        if (!gifPut.ok) throw new Error(`GIF 上传失败（${gifPut.status}）`)
        assetUrl = `${API}/assets/${(await gifPut.json()).name}`
        gifAssetByUrl.set(el.src, assetUrl)
      }
      overlays.push({ ...el, src: assetUrl })
    }

    // 页面重写为「整页底图 + GIF 覆盖层」——标准 Slide 结构，播放端零改动
    slide.elements = overlays
    slide.background = { type: 'image', image: { src: `${API}/assets/${pageAsset}`, size: 'cover' } }
    progressPercent.value = Math.round(((i + 1) / total) * 70)
  }

  for (const url of allBlobUrls) URL.revokeObjectURL(url)
}

const upload = async () => {
  if (!selectedFile.value || !parsed.value || uploading.value) return
  if (uploadTarget.value === 'main' && !parsedV3.value) return
  if (uploadTarget.value === 'secondary' && !parsedBundleParts.value) return
  uploading.value = true
  errorText.value = ''
  successText.value = ''
  progressPercent.value = 0

  try {
    if (uploadTarget.value === 'main') {
      const v3 = parsedV3.value!
      // 1. 会话
      const session = await (await fetch(`${API}/upload-sessions`, { method: 'POST' })).json()
      const sessionUrl = `${API}/upload-sessions/${session.sessionId}`
      // 2. 逐页渲染整页图片 + 剥离 GIF 覆盖层，页面图/资产逐个直传（slides 原地重写）
      await prepareMainDeckV3(session.sessionId)
      // 3. 原始文件流式上传
      statusText.value = `上传原始文件 ...`
      progressPercent.value = 72
      const rawPut = await fetch(`${sessionUrl}/raw`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: selectedFile.value,
      })
      if (!rawPut.ok) throw new Error(`原始文件上传失败（${rawPut.status}）`)
      // 4. 轻结构 bundle：与播放端协议一致（slides 数组），每页=整页底图+GIF覆盖层
      statusText.value = '上传文稿结构 ...'
      progressPercent.value = 94
      const bundle = {
        title: v3.title || slidesStore.title,
        slides: v3.slides,
        theme: v3.theme,
        viewportSize: v3.viewportSize,
        viewportRatio: v3.viewportRatio,
      }
      const bundlePut = await fetch(`${sessionUrl}/bundle`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
      })
      if (!bundlePut.ok) throw new Error(`文稿数据上传失败（${bundlePut.status}）`)
      // 5. 原子发布
      progressPercent.value = 99
      statusText.value = '发布新版本 ...'
      const commit = await fetch(`${sessionUrl}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: selectedFile.value.name, pageCount: pagesCount.value || v3.slides.length }),
      })
      const result = await commit.json().catch(() => null)
      if (!commit.ok || !result?.ok) throw new Error(result?.error || `发布失败（${commit.status}）`)
      successText.value = '已设为默认 PPT，更新通知已发送。播放页面加载完成后将自动切换。'
      const meta = await fetchDefaultPptCurrent()
      currentMeta.value = meta
    }
    else {
      progressPercent.value = 100
      statusText.value = '保存中 ...'
      const result = await uploadDefaultPpt({
        filename: selectedFile.value.name,
        file: selectedFile.value,
        pageCount: parsedPageCount.value,
        bundleParts: parsedBundleParts.value!,
      }, percent => (progressPercent.value = percent), uploadTarget.value)
      successText.value = '已设为副屏文稿（PPTist B），副屏页加载完成后将自动切换。'
      secondaryMeta.value = result
    }
    statusText.value = ''
  }
  catch (error) {
    // 失败不影响旧默认 PPT，也不影响正在播放的页面
    errorText.value = (error as Error)?.message || '上传失败'
    statusText.value = ''
  }
  finally {
    uploading.value = false
  }
}

const copyUploadUrl = async () => {
  try {
    await copyText(uploadUrl.value)
    message.success('上传地址已复制')
  }
  catch {
    message.error('复制失败，请手动选择地址复制')
  }
}

onMounted(async () => {
  // 本页面不进入放映，也绝不发送放映事件（不修改 screening）
  slidesStore.setSlides([{ id: nanoid(10), elements: [] }])
  try {
    config.value = await fetchDefaultPptConfig()
    configFetched.value = true
  }
  catch {
    /* 服务端不可达时仍可查看界面，上传时会提示具体错误 */
  }
  try {
    currentMeta.value = await fetchDefaultPptCurrent()
  }
  catch {
    /* 忽略，展示为暂无 */
  }
  try {
    secondaryMeta.value = await fetchSecondaryDocCurrent()
  }
  catch {
    /* 忽略，展示为暂无 */
  }
  unsubscribe = subscribeDefaultPptEvents({
    onVersion: meta => {
      if (meta.exists) currentMeta.value = meta
    },
  })
  const unsubscribeSecondary = subscribeSecondaryDocEvents({
    onVersion: meta => {
      if (meta.exists) secondaryMeta.value = meta
    },
  })
  onUnmounted(() => unsubscribeSecondary())
})

onUnmounted(() => unsubscribe?.())
</script>

<style lang="scss" scoped>
.pptist-upload {
  min-height: 100vh;
  background-color: #f5f6f8;
}
.header {
  height: 52px;
  background-color: #fff;
  border-bottom: 1px solid $borderColor;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;

  .brand {
    display: flex;
    justify-content: center;
    align-items: center;

    .logo {
      height: 22px;
      margin-right: 10px;
    }
    .name {
      font-size: 15px;
      font-weight: 700;
    }
  }
  .links {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 16px;

    .link {
      font-size: 13px;
      color: $themeColor;
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }
  }
}
.content {
  max-width: 960px;
  margin: 24px auto;
  padding: 0 16px;
  display: flex;
  gap: 16px;
  align-items: flex-start;

  .main {
    flex: 1;
    min-width: 0;
  }
  .side {
    width: 300px;
    flex-shrink: 0;
  }
}
.card {
  background-color: #fff;
  border: 1px solid $borderColor;
  border-radius: $borderRadius;
  padding: 18px 20px;
  margin-bottom: 16px;

  .card-title {
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 14px;
  }
}
.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  .target-label {
    font-size: 13px;
    color: #666;
    flex-shrink: 0;
  }
  .target-btn {
    border: 1px solid $borderColor;
    background: #fff;
    border-radius: $borderRadius;
    font-size: 13px;
    padding: 5px 12px;
    cursor: pointer;
    color: #666;
    transition: all .2s;

    &:hover { border-color: $themeColor; color: $themeColor; }
    &.active {
      border-color: $themeColor;
      background: $themeColor;
      color: #fff;
    }
  }
}
.target-tip {
  font-size: 12px;
  color: #999;
  margin-bottom: 12px;
}
.drop-area {
  border: 1px dashed #c9cdd4;
  border-radius: $borderRadius;
  padding: 34px 16px;
  text-align: center;
  cursor: pointer;
  transition: border-color .2s, background-color .2s;

  &.dragging {
    border-color: $themeColor;
    background-color: #fdf5f2;
  }
  &:hover {
    border-color: $themeColor;
  }
  .drop-icon {
    font-size: 32px;
    color: $themeColor;
    margin-bottom: 8px;
  }
  .drop-text {
    font-size: 14px;
  }
  .drop-sub {
    font-size: 12px;
    color: #999;
    margin-top: 6px;
  }
}
.file-info {
  display: flex;
  align-items: center;
  margin-top: 14px;

  .file-icon {
    font-size: 22px;
    color: $themeColor;
    margin-right: 10px;
  }
  .file-name {
    font-size: 13px;
    word-break: break-all;
  }
  .file-size {
    font-size: 12px;
    color: #999;
    margin-top: 2px;
  }
}
.step-status {
  font-size: 13px;
  color: #555;
  margin-top: 14px;
}
.progress {
  height: 6px;
  background-color: #eef0f3;
  border-radius: 3px;
  margin-top: 10px;
  overflow: hidden;

  .progress-inner {
    height: 100%;
    background-color: $themeColor;
    border-radius: 3px;
    transition: width .2s;
  }
}
.error-text {
  font-size: 13px;
  color: #d65050;
  margin-top: 12px;
  line-height: 1.6;
  word-break: break-all;
}
.success-text {
  font-size: 13px;
  color: #47a04b;
  display: flex;
  align-items: flex-start;
  line-height: 1.7;
  word-break: break-all;

  .success-icon {
    font-size: 16px;
    margin-right: 8px;
    margin-top: 2px;
    flex-shrink: 0;
  }
}
.primary-btn {
  width: 100%;
  height: 40px;
  margin-top: 16px;
  border: 0;
  border-radius: $borderRadius;
  background-color: $themeColor;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;

  &:hover:not(:disabled) {
    opacity: .9;
  }
  &:disabled {
    background-color: #f1f2f4;
    color: #b7b7b7;
    cursor: not-allowed;
  }
}
.btn-tip {
  font-size: 12px;
  color: #999;
  margin-top: 10px;
  line-height: 1.6;
}
.btn-icon {
  font-size: 15px;
  margin-right: 6px;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.8;

  .meta-label {
    color: #999;
    flex-shrink: 0;
    margin-right: 12px;
  }
  .meta-value {
    text-align: right;
    word-break: break-all;
  }
}
.empty-meta {
  font-size: 13px;
  color: #999;
  margin-bottom: 12px;
}
.play-link {
  margin-top: 12px;
  font-size: 13px;
  color: $themeColor;
  text-decoration: none;
  display: flex;
  align-items: center;

  &:hover {
    text-decoration: underline;
  }
}
.address-row {
  display: flex;
  align-items: center;
  gap: 8px;

  .address {
    flex: 1;
    min-width: 0;
    font-family: monospace;
    font-size: 12px;
    background-color: #f5f6f8;
    border: 1px solid $borderColor;
    border-radius: $borderRadius;
    padding: 6px 8px;
    word-break: break-all;
  }
}
.mini-btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid #d9d9d9;
  border-radius: $borderRadius;
  background-color: #fff;
  color: $textColor;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;

  &:hover {
    border-color: $themeColor;
    color: $themeColor;
  }
}
.warn-text {
  font-size: 12px;
  color: #d08a1d;
  margin-top: 10px;
  line-height: 1.6;
}
.steps {
  font-size: 12px;
  color: #999;
  margin-top: 10px;
  line-height: 1.6;
}
</style>
