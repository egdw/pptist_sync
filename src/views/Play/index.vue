<template>
  <div class="pptist-play">
    <template v-if="phase === 'playing'">
      <BaseView
        v-if="viewMode === 'base'"
        :key="`base-${loadedSeq}`"
        :changeViewMode="changeViewMode"
        keepPlayingOnFullscreenEsc
        clickToAdvance
      />
      <PresenterView
        v-else-if="viewMode === 'presenter'"
        :key="`presenter-${loadedSeq}`"
        :changeViewMode="changeViewMode"
        keepPlayingOnFullscreenEsc
      />
    </template>

    <!-- 尚无默认 PPT：显示引导并持续等待，首次上传成功后自动进入放映 -->
    <div v-else-if="phase === 'empty'" class="placeholder">
      <div class="placeholder-main">
        <i-icon-park-outline:ppt class="placeholder-icon" />
        <div class="placeholder-title">暂无默认 PPT</div>
        <div class="placeholder-desc">请通过上传页面上传，首次上传成功后本页面将自动进入放映。</div>
        <button class="primary-btn" @click="guideVisible = true"><i-icon-park-outline:upload class="btn-icon" /> 上传 PPT</button>
        <div class="steps">打开上传页 → 选择 PPTX → 上传并设为默认</div>
        <div class="address-row">
          <span class="address">{{ uploadUrl }}</span>
          <button class="mini-btn" @click="copyUploadUrl()">复制地址</button>
        </div>
        <div class="warn-text" v-if="isLocalAddress">当前地址仅本机可用：请在其他电脑上使用服务器的局域网 IP 访问（如 http://192.168.x.x:{{ port }}）。</div>
        <button class="text-link" @click="openEditor()">打开编辑器（回到原来的界面）</button>
      </div>
    </div>

    <!-- 用户主动结束放映后 -->
    <div v-else-if="phase === 'stopped'" class="placeholder">
      <div class="placeholder-main">
        <div class="placeholder-title">放映已结束</div>
        <div class="placeholder-desc">可重新开始放映、上传新的默认 PPT，或回到原来的编辑器界面。</div>
        <div class="btn-row">
          <button class="primary-btn" @click="restartPlay()"><i-icon-park-outline:play class="btn-icon" /> 从第一页重新放映</button>
          <button class="mini-btn" @click="guideVisible = true">上传 / 更换 PPT</button>
          <button class="mini-btn" @click="linkPanelVisible = true">放映联动设置</button>
        </div>
        <button class="text-link" @click="openEditor()">打开编辑器（回到原来的界面）</button>
      </div>
    </div>

    <FullscreenSpin v-else loading tip="正在加载默认 PPT ..." :mask="false" />

    <!-- 右上角入口：默认可见，不依赖悬停，不遮挡幻灯片主体；原生全屏时整排隐藏（ESC 退出全屏后恢复） -->
    <div class="upload-entry" v-if="phase !== 'empty' && !fullscreenActive">
      <button class="upload-entry-btn" @click="tryEnterFullscreen()" v-tooltip="'进入原生全屏'">
        <i-icon-park-outline:full-screen-one class="icon" /> 全屏
      </button>
      <button class="upload-entry-btn" @click="linkPanelVisible = true">
        <i-icon-park-outline:setting class="icon" /> 放映联动
      </button>
      <button class="upload-entry-btn" @click="guideVisible = !guideVisible">
        <i-icon-park-outline:upload class="icon" /> 上传 / 更换 PPT
      </button>
    </div>

    <!-- 上传指引浮层 -->
    <div class="guide-mask" v-if="guideVisible" @click.self="guideVisible = false">
      <div class="guide-panel">
        <div class="guide-title">上传 / 更换 PPT</div>
        <div class="guide-section" v-if="currentMeta.exists">
          <div class="guide-label">当前默认：</div>
          <div class="guide-value">{{ currentMeta.filename }}（{{ currentMeta.pageCount }} 页，更新于 {{ formatTime(currentMeta.updatedAt) }}）</div>
        </div>
        <div class="guide-section" v-else>
          <div class="guide-label">当前默认：</div>
          <div class="guide-value">暂无</div>
        </div>
        <div class="guide-section">
          <div class="guide-label">上传页面地址：</div>
          <div class="address-row">
            <span class="address">{{ uploadUrl }}</span>
            <button class="mini-btn" @click="copyUploadUrl()">复制地址</button>
          </div>
          <div class="warn-text" v-if="isLocalAddress">
            当前页面通过 {{ hostname }} 访问，该地址仅本机可用；请在其他电脑上使用服务器的局域网 IP 访问。
          </div>
        </div>
        <div class="guide-hint">
          在同一局域网的电脑上打开此地址，选择 .pptx 文件，点击“上传并设为默认”。上传成功后，本播放页将自动更新，下次打开仍播放这份 PPT。
        </div>
        <div class="guide-steps">打开上传页 → 选择 PPTX → 上传并设为默认</div>
        <div class="guide-btns">
          <button class="primary-btn" @click="openUploadPage()"><i-icon-park-outline:link class="btn-icon" /> 打开上传页面</button>
          <button class="mini-btn" @click="linkPanelVisible = true">放映联动设置</button>
          <button class="mini-btn" @click="openEditor()">打开编辑器</button>
          <button class="mini-btn" @click="guideVisible = false">关闭</button>
        </div>
        <div class="guide-note">上传与放映功能互不影响，本页面将继续播放当前 PPT。</div>
      </div>
    </div>

    <!-- 放映联动设置（与编辑器内完全相同的配置面板） -->
    <Modal
      :visible="linkPanelVisible"
      :width="640"
      closeButton
      :contentStyle="{ maxHeight: '86vh', overflow: 'auto' }"
      @closed="linkPanelVisible = false"
    >
      <div class="presentation-link-modal">
        <div class="modal-title">放映联动</div>
        <PresentationLinkPanel />
      </div>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import { useScreenStore, useSlidesStore } from '@/store'
import {
  applyBundleToSlidesStore,
  fetchDefaultPptConfig,
  fetchDefaultPptCurrent,
  fetchDefaultPptSlides,
  subscribeDefaultPptEvents,
  type DefaultPptBundle,
  type DefaultPptMeta,
} from '@/services/defaultPpt'
import { copyText } from '@/utils/clipboard'
import { enterFullscreen, isFullscreen } from '@/utils/fullscreen'
import message from '@/utils/message'

import FullscreenSpin from '@/components/FullscreenSpin.vue'
import Modal from '@/components/Modal.vue'
import PresentationLinkPanel from '@/views/Editor/PresentationLinkPanel.vue'
import BaseView from '@/views/Screen/BaseView.vue'
import PresenterView from '@/views/Screen/PresenterView.vue'

type Phase = 'loading' | 'empty' | 'playing' | 'stopped'

const screenStore = useScreenStore()
const slidesStore = useSlidesStore()
const { screening } = storeToRefs(screenStore)

const phase = ref<Phase>('loading')
const viewMode = ref<'base' | 'presenter'>('base')
const guideVisible = ref(false)
const linkPanelVisible = ref(false)
const loadedSeq = ref(0)
const currentMeta = ref<DefaultPptMeta>({ exists: false })
const publicBaseUrl = ref<string | null>(null)
const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80')

// 服务端推送的默认 PPT 版本通知（内部使用，与对外四字段放映事件完全无关）
let unsubscribe: (() => void) | null = null
let syncing = false
let latestNotice: DefaultPptMeta | null = null
let syncStopped = false
// 向观众窗口完整同步新文稿（同一频道，观众视图已支持 INIT_STATE）
const audienceChannel = new BroadcastChannel('pptist-audience-sync')

const hostname = computed(() => window.location.hostname)
const isLocalAddress = computed(() => ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(hostname.value))
const uploadUrl = computed(() => {
  const base = (publicBaseUrl.value || window.location.origin).replace(/\/+$/, '')
  return `${base}/upload`
})

const changeViewMode = (mode: 'base' | 'presenter') => {
  viewMode.value = mode
}

const formatTime = (time?: string) => {
  if (!time) return '—'
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? time : date.toLocaleString('zh-CN', { hour12: false })
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

const openUploadPage = () => {
  window.open(uploadUrl.value, '_blank')
}

/** 回到原来的编辑器界面（当前标签页跳转） */
const openEditor = () => {
  const base = (publicBaseUrl.value || window.location.origin).replace(/\/+$/, '')
  window.location.href = `${base}/editor`
}

// 用户主动结束放映（工具栏按钮等）后进入停止态；热替换内部的瞬时 false 会在同一帧内被 true 覆盖
watch(screening, value => {
  if (value) phase.value = 'playing'
  else if (phase.value === 'playing') phase.value = 'stopped'
})

// —— 原生全屏：与编辑器 F5 放映一致 ——
// 打开页面即尝试；因缺少用户操作被浏览器拒绝时，在首次有效交互（点击画面、翻页笔、键盘）
// 时再次尝试；热替换后同样自动尝试并重新布防。以上均失败时可用右上角「全屏」按钮手动进入。
const fullscreenActive = ref(isFullscreen())
let gestureBound = false
let everFullscreen = false

const tryEnterFullscreen = () => {
  if (isFullscreen()) return
  try {
    const result = enterFullscreen() as unknown
    if (result instanceof Promise) result.catch(() => { /* 无手势时被拒绝属预期 */ })
  }
  catch { /* 同上 */ }
}

const onFullscreenChange = () => {
  fullscreenActive.value = isFullscreen()
  // 已进入过全屏：解除“首次交互进入全屏”布防，避免用户主动退出后又被拉起
  if (fullscreenActive.value) {
    everFullscreen = true
    unbindFirstGesture()
  }
}
document.addEventListener('fullscreenchange', onFullscreenChange)
document.addEventListener('webkitfullscreenchange', onFullscreenChange)

const onFirstGesture = (e: Event) => {
  const target = e.target as Element | null
  // 界面控件（上传、指引、设置弹窗、占位页）上的操作不触发全屏
  if (target?.closest?.('.upload-entry, .guide-mask, .modal, .placeholder')) return
  tryEnterFullscreen()
  if (isFullscreen()) unbindFirstGesture()
}
const bindFirstGesture = () => {
  if (gestureBound || fullscreenActive.value) return
  gestureBound = true
  window.addEventListener('pointerdown', onFirstGesture, true)
  window.addEventListener('keydown', onFirstGesture, true)
}
const unbindFirstGesture = () => {
  if (!gestureBound) return
  gestureBound = false
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('keydown', onFirstGesture, true)
}

// 打开页面 60 秒后仍未进入原生全屏，则自动尝试进入（此前进入过全屏、或当前已全屏则不影响）。
// 浏览器要求至少一次用户交互才允许全屏：只要 60 秒内有过任意点击/按键，此处即可成功。
const AUTO_FULLSCREEN_DELAY = 60000
let autoFullscreenTimer: ReturnType<typeof setTimeout> | null = null
const armAutoFullscreen = () => {
  if (autoFullscreenTimer) clearTimeout(autoFullscreenTimer)
  autoFullscreenTimer = setTimeout(() => {
    autoFullscreenTimer = null
    if (!everFullscreen && !isFullscreen()) tryEnterFullscreen()
  }, AUTO_FULLSCREEN_DELAY)
}

/** 将服务端文稿数据应用到 store。替换期间 screenings 的瞬时变化即 ended → started 时序 */
function applyBundle(bundle: DefaultPptBundle) {
  const wasPlaying = phase.value === 'playing' && screening.value

  // 正在播放旧文稿：先结束（对外发送旧文稿最后停留页的 presentation.ended）
  if (wasPlaying) screenStore.setScreening(false)

  applyBundleToSlidesStore(bundle)
  slidesStore.updateSlideIndex(0)

  phase.value = 'playing'
  // 再进入放映（对外发送新文稿第一页的 presentation.started）；此前未在放映时只会发送 started
  screenStore.setScreening(true)

  broadcastAudienceState()

  // 更新后默认全屏：立即尝试；若无用户手势被拒绝，则重新布防首次交互（翻页/按键时进入全屏）
  tryEnterFullscreen()
  bindFirstGesture()
  armAutoFullscreen()
}

/** 观众窗口：推送完整新文稿数据（而不是只同步页码） */
function broadcastAudienceState() {
  try {
    audienceChannel.postMessage({
      type: 'INIT_STATE',
      slideIndex: 0,
      animationIndex: 0,
      viewportSize: slidesStore.viewportSize,
      viewportRatio: slidesStore.viewportRatio,
      slides: JSON.parse(JSON.stringify(slidesStore.slides)),
    })
  }
  catch {
    /* 观众同步失败不影响主控播放 */
  }
}

const restartPlay = () => {
  slidesStore.updateSlideIndex(0)
  screenStore.setScreening(true)
  broadcastAudienceState()
}

/**
 * 与服务端对账：拉取当前版本并按需加载/热替换。
 * - 通知版本 <= 已加载版本：忽略（重复通知 / 过期通知）；
 * - 加载使用响应头中的实际版本号，请求期间服务端更新到更新版本时不会错配；
 * - 加载失败保持旧文稿继续播放，不产生任何放映事件。
 */
async function syncLoop() {
  if (syncing || syncStopped) return
  syncing = true
  try {
    while (!syncStopped) {
      const meta = latestNotice && latestNotice.exists ? latestNotice : await fetchDefaultPptCurrent()
      currentMeta.value = meta

      if (!meta.exists) {
        if (phase.value !== 'playing') phase.value = 'empty'
        return
      }
      if ((meta.seq || 0) <= loadedSeq.value) return

      const { bundle, seq } = await fetchDefaultPptSlides()
      if (seq <= loadedSeq.value) return
      applyBundle(bundle)
      loadedSeq.value = seq
      currentMeta.value = { exists: true, seq, version: `v${seq}`, filename: meta.filename, pageCount: bundle.slides.length, updatedAt: meta.updatedAt }
    }
  }
  catch (error) {
    // 首次加载失败：显示等待态（可重试）；热替换失败：保持旧文稿继续放映
    if (phase.value === 'loading') phase.value = 'empty'
    console.warn('[play] 同步默认 PPT 失败：', error)
  }
  finally {
    syncing = false
  }
}

const handleVersionNotice = (meta: DefaultPptMeta) => {
  latestNotice = meta
  if (meta.exists) currentMeta.value = meta
  else if (phase.value !== 'playing') phase.value = 'empty'
  syncLoop()
}

// 尽力进入原生全屏（与编辑器 F5 放映一致）。浏览器可能因缺少用户操作拒绝请求，
// 此时页面仍铺满可视区正常放映；可用右上角「全屏」按钮手动进入。
// tryEnterFullscreen / onFirstGesture / bindFirstGesture / unbindFirstGesture 见上方全屏区块

onMounted(async () => {
  tryEnterFullscreen()
  bindFirstGesture()
  armAutoFullscreen()
  try {
    const config = await fetchDefaultPptConfig()
    publicBaseUrl.value = config.publicBaseUrl
  }
  catch {
    /* 配置获取失败时回退到当前 origin */
  }
  unsubscribe = subscribeDefaultPptEvents({
    onVersion: handleVersionNotice,
    onOpen: () => syncLoop(), // 通知通道重连：核对当前版本，补上断线期间错过的更新
  })
  syncLoop()
})

onUnmounted(() => {
  if (autoFullscreenTimer) clearTimeout(autoFullscreenTimer)
  unbindFirstGesture()
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  syncStopped = true
  unsubscribe?.()
  audienceChannel.close()
})

// ESC 关闭指引浮层（不退出放映）
const keydownListener = (e: KeyboardEvent) => {
  if (e.key.toUpperCase() === 'ESC' && guideVisible.value) guideVisible.value = false
}
onMounted(() => document.addEventListener('keydown', keydownListener))
onUnmounted(() => document.removeEventListener('keydown', keydownListener))
</script>

<style lang="scss" scoped>
.pptist-play {
  width: 100%;
  height: 100%;
}
.placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #1a1a1e;
  color: #fff;
}
.placeholder-main {
  width: 520px;
  max-width: 90%;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;

  .placeholder-icon {
    font-size: 56px;
    margin-bottom: 16px;
    color: #5b9bd5;
  }
  .placeholder-title {
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 10px;
  }
  .placeholder-desc {
    font-size: 14px;
    color: #b9bcc4;
    margin-bottom: 20px;
    line-height: 1.6;
  }
  .steps {
    font-size: 13px;
    color: #b9bcc4;
    margin: 14px 0 10px;
  }
}
.btn-row {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 10px;
}
.primary-btn {
  height: 40px;
  padding: 0 22px;
  border: 0;
  border-radius: $borderRadius;
  background-color: $themeColor;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;

  &:hover {
    opacity: .9;
  }
}
.mini-btn {
  height: 32px;
  padding: 0 14px;
  border: 1px solid #55585f;
  border-radius: $borderRadius;
  background-color: transparent;
  color: #e6e7ea;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    border-color: $themeColor;
    color: $themeColor;
  }
}
.btn-icon {
  font-size: 16px;
  margin-right: 6px;
}
.address-row {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  margin-top: 6px;

  .address {
    font-family: monospace;
    font-size: 13px;
    background-color: #2a2c33;
    padding: 6px 10px;
    border-radius: $borderRadius;
    word-break: break-all;
  }
}
.warn-text {
  font-size: 12px;
  color: #e6b34d;
  margin-top: 10px;
  line-height: 1.6;
  text-align: left;
}
.upload-entry {
  position: fixed;
  top: 10px;
  right: 12px;
  z-index: 100;
  display: flex;
  gap: 8px;

  .upload-entry-btn {
    height: 34px;
    padding: 0 14px;
    display: flex;
    justify-content: center;
    align-items: center;
    border: 1px solid rgba(255, 255, 255, .25);
    border-radius: $borderRadius;
    background-color: rgba(30, 32, 38, .65);
    color: rgba(255, 255, 255, .85);
    font-size: 13px;
    cursor: pointer;
    transition: all .2s;

    .icon {
      font-size: 15px;
      margin-right: 6px;
    }
    &:hover {
      border-color: $themeColor;
      color: $themeColor;
    }
  }
}
.text-link {
  margin-top: 18px;
  background: none;
  border: 0;
  color: #8ab4e8;
  font-size: 13px;
  cursor: pointer;
  text-decoration: underline;

  &:hover {
    color: #fff;
  }
}
.presentation-link-modal {
  .modal-title {
    font-size: 14px;
    font-weight: 700;
    padding: 14px 20px 0;
  }
}
.guide-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 200;
  background-color: rgba(0, 0, 0, .35);
  display: flex;
  justify-content: center;
  align-items: center;
}
.guide-panel {
  width: 480px;
  max-width: 92%;
  max-height: 86vh;
  overflow: auto;
  background-color: #fff;
  border-radius: $borderRadius;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .25);
  padding: 20px 24px;
  color: $textColor;

  .guide-title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 14px;
  }
  .guide-section {
    margin-bottom: 12px;

    .guide-label {
      font-size: 12px;
      color: #999;
      margin-bottom: 4px;
    }
    .guide-value {
      font-size: 13px;
      word-break: break-all;
    }
    .address-row {
      justify-content: flex-start;

      .address {
        background-color: #f5f6f8;
        border: 1px solid $borderColor;
        color: $textColor;
      }
    }
    .warn-text {
      color: #d08a1d;
    }
  }
  .guide-hint {
    font-size: 13px;
    line-height: 1.7;
    color: #555;
    background-color: #f5f6f8;
    border-radius: $borderRadius;
    padding: 10px 12px;
    margin-bottom: 10px;
  }
  .guide-steps {
    font-size: 12px;
    color: #999;
    margin-bottom: 16px;
  }
  .guide-btns {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .guide-note {
    font-size: 12px;
    color: #999;
  }
  .primary-btn {
    background-color: $themeColor;
  }
  .mini-btn {
    border-color: #d9d9d9;
    color: $textColor;

    &:hover {
      border-color: $themeColor;
      color: $themeColor;
    }
  }
}
</style>
