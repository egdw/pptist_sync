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
          <div
            class="drop-area"
            :class="{ dragging }"
            @click="selectFile()"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="handleDrop"
          >
            <i-icon-park-outline:upload class="drop-icon" />
            <div class="drop-text">点击选择或拖入 .pptx 文件</div>
            <div class="drop-sub">允许类型：.pptx；大小上限：{{ config.maxUploadMB }}MB</div>
            <input ref="fileInputRef" type="file" accept=".pptx" hidden @change="handleFileChange" />
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
          <div class="error-text" v-if="errorText">{{ errorText }}</div>

          <button class="primary-btn" :disabled="!canUpload" @click="upload()">
            <i-icon-park-outline:upload class="btn-icon" /> {{ uploading ? '上传中 ...' : '上传并设为默认' }}
          </button>
          <div class="btn-tip">上传成功后将替换当前默认 PPT，已打开的播放页面会自动切换到新 PPT 的第一页。</div>
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
          <div class="card-title">当前默认 PPT</div>
          <template v-if="currentMeta.exists">
            <div class="meta-row"><span class="meta-label">文件名</span><span class="meta-value">{{ currentMeta.filename }}</span></div>
            <div class="meta-row"><span class="meta-label">页数</span><span class="meta-value">{{ currentMeta.pageCount }}</span></div>
            <div class="meta-row"><span class="meta-label">更新时间</span><span class="meta-value">{{ formatTime(currentMeta.updatedAt) }}</span></div>
            <div class="meta-row"><span class="meta-label">版本</span><span class="meta-value">{{ currentMeta.version }}</span></div>
          </template>
          <div class="empty-meta" v-else>暂无默认 PPT</div>
          <a class="play-link" :href="playUrl" target="_blank"><i-icon-park-outline:play class="btn-icon" /> 打开播放页</a>
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
  fileToBase64,
  subscribeDefaultPptEvents,
  uploadDefaultPpt,
  type DefaultPptConfig,
  type DefaultPptMeta,
} from '@/services/defaultPpt'
import { copyText } from '@/utils/clipboard'
import message from '@/utils/message'

const slidesStore = useSlidesStore()
const { slides } = storeToRefs(slidesStore)
const { importPPTXFile, exporting } = useImport()

const config = ref<DefaultPptConfig>({ publicBaseUrl: null, maxUploadMB: 100, acceptTypes: ['.pptx'] })
const currentMeta = ref<DefaultPptMeta>({ exists: false })
const selectedFile = ref<File | null>(null)
const parsed = ref(false)
const parsing = ref(false)
const uploading = ref(false)
const statusText = ref('')
const errorText = ref('')
const successText = ref('')
const progressPercent = ref(0)
const dragging = ref(false)
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

const progressVisible = computed(() => uploading.value || parsing.value)
const canUpload = computed(() => !!selectedFile.value && parsed.value && !uploading.value)

const formatTime = (time?: string) => {
  if (!time) return '—'
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? time : date.toLocaleString('zh-CN', { hour12: false })
}

const selectFile = () => fileInputRef.value?.click()

const validateFile = (file: File): string | null => {
  if (!/\.pptx$/i.test(file.name)) return '仅支持 .pptx 文件'
  if (file.size > config.value.maxUploadMB * 1024 * 1024) return `文件超过大小上限（${config.value.maxUploadMB}MB）`
  if (file.size === 0) return '文件内容为空'
  return null
}

const resetParseState = () => {
  parsed.value = false
  errorText.value = ''
  successText.value = ''
  progressPercent.value = 0
}

const handleFile = (file: File) => {
  const invalid = validateFile(file)
  if (invalid) {
    errorText.value = invalid
    selectedFile.value = null
    return
  }
  selectedFile.value = file
  resetParseState()
  statusText.value = '解析中 ...'
  parsing.value = true

  // 解析前重置为单页空文稿：复用现有 PPTX 导入管线（导入结果写入本地 store，本页不进入放映、不发送放映事件）
  seedSlideId = nanoid(10)
  slidesStore.setSlides([{ id: seedSlideId, elements: [] }])
  slidesStore.updateSlideIndex(0)
  importPPTXFile([file])
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

// 现有导入流程无完成回调，通过 exporting 状态判断解析结束
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
  parsed.value = true
  statusText.value = `解析成功：共 ${resultSlides.length} 页，可以上传`
})

const upload = async () => {
  if (!selectedFile.value || !parsed.value || uploading.value) return
  uploading.value = true
  errorText.value = ''
  successText.value = ''
  statusText.value = '上传中 ...'
  progressPercent.value = 0

  try {
    const fileBase64 = await fileToBase64(selectedFile.value)
    progressPercent.value = 100
    statusText.value = '保存中 ...'
    const result = await uploadDefaultPpt({
      filename: selectedFile.value.name,
      fileBase64,
      bundle: {
        title: slidesStore.title,
        slides: JSON.parse(JSON.stringify(slides.value)),
        theme: JSON.parse(JSON.stringify(slidesStore.theme)),
        viewportSize: slidesStore.viewportSize,
        viewportRatio: slidesStore.viewportRatio,
      },
    }, percent => (progressPercent.value = percent))
    successText.value = '已设为默认 PPT，更新通知已发送。播放页面加载完成后将自动切换。'
    statusText.value = ''
    currentMeta.value = result
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
  unsubscribe = subscribeDefaultPptEvents({
    onVersion: meta => {
      if (meta.exists) currentMeta.value = meta
    },
  })
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
