<template>
  <div class="pptist-secondary">
    <FullscreenSpin v-if="phase === 'loading'" tip="正在加载副屏文稿 ..." loading :mask="false" />
    <div v-else-if="phase === 'empty'" class="placeholder">
      <div class="placeholder-main">
        <div class="placeholder-icon"><i-icon-park-outline:ppt class="icon" /></div>
        <div class="placeholder-text">暂无副屏文稿</div>
        <div class="placeholder-sub">这是副屏（PPTist B）独立文稿槽位，与主屏 PPT 完全独立。请在 /upload 页将上传目标切到「副屏文稿」上传，上传后本页自动更新</div>
        <button class="retry-btn" @click="retry()">重新加载</button>
      </div>
    </div>
    <div v-else-if="phase === 'error'" class="placeholder">
      <div class="placeholder-main">
        <div class="placeholder-icon error"><i-icon-park-outline:close-one class="icon" /></div>
        <div class="placeholder-text">副屏文稿加载失败</div>
        <div class="placeholder-sub">{{ errorMessage }}</div>
        <button class="retry-btn" @click="retry()">重试</button>
      </div>
    </div>
    <BaseView v-else :changeViewMode="noop" />

    <div class="status-chip" :class="statusLevel">
      <span class="dot"></span>
      <span>{{ statusText }}</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { nextTick } from 'vue'
import { useSlidesStore } from '@/store'
import {
  applyBundleToSlidesStore,
  fetchSecondaryDocCurrent,
  fetchSecondaryDocSlides,
  subscribeSecondaryDocEvents,
  type DefaultPptMeta,
} from '@/services/defaultPpt'
import { SecondaryShowFlowClient } from '@/show-flow/secondaryClient'
import { resolveShowFlowWsUrl } from '@/show-flow/websocket/client'
import { useShowFlowStore } from '@/show-flow/store'
import type { ShowFlowMessage } from '@/show-flow/websocket/protocol'

import BaseView from '@/views/Screen/BaseView.vue'
import FullscreenSpin from '@/components/FullscreenSpin.vue'

const slidesStore = useSlidesStore()
const showFlowStore = useShowFlowStore()

const phase = ref<'loading' | 'empty' | 'playing' | 'error'>('loading')
const loadedSeq = ref(0)
const errorMessage = ref('')

/** 带超时的 fetch：服务端不可达 / 接口挂起时不再无限转圈 */
async function fetchWithTimeout(url: string, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { cache: 'no-store', signal: controller.signal })
  }
  finally {
    clearTimeout(timer)
  }
}

// ---------- 文档加载 / 热更新（与 /play 播放页同源逻辑） ----------
let syncing = false
let syncStopped = false
let unsubscribe: (() => void) | null = null
let latestNotice: DefaultPptMeta | null = null
const docName = ref('')

async function syncLoop() {
  if (syncing || syncStopped) return
  syncing = true
  try {
    const meta = latestNotice && latestNotice.exists ? latestNotice : await fetchSecondaryDocCurrent()
    // meta 可能为 null：服务端版本过旧（无此接口，SPA 回退返回 HTML）时 requestJson 解析失败返回 null
    if (!meta || !meta.exists) {
      if (phase.value === 'loading' || phase.value === 'error') phase.value = 'empty'
      return
    }
    if ((meta.seq || 0) <= loadedSeq.value) {
      if (phase.value === 'loading') phase.value = 'playing'
      return
    }
    const { bundle, seq } = await fetchSecondaryDocSlides()
    if (seq <= loadedSeq.value) return
    applyBundleToSlidesStore(bundle)
    slidesStore.updateSlideIndex(0)
    loadedSeq.value = seq
    docName.value = bundle.title || meta.filename || '未命名文稿'
    phase.value = 'playing'
  }
  catch (error) {
    // 首次加载失败：进入错误态（可重试）；热更新失败：保持旧文稿继续播放
    if (phase.value === 'loading' || phase.value === 'empty') {
      phase.value = 'error'
      const err = error as Error
      errorMessage.value = err?.name === 'AbortError'
        ? '连接服务端超时，请确认服务端已启动（且为本项目最新版本的 server/pptist-server.mjs）'
        : (err?.message || '未知错误，请确认服务端为最新版本（需支持 /showflow-api/secondary-doc 接口）')
    }
  }
  finally {
    syncing = false
  }
}

const retry = () => {
  phase.value = 'loading'
  syncLoop()
}

const handleVersionNotice = (meta: DefaultPptMeta) => {
  latestNotice = meta
  syncLoop()
}

// ---------- ShowFlow 副屏客户端（受控导航 + 渲染后 ACK + 幂等） ----------
/** 切页 → nextTick → 至少一帧渲染后才 resolve（ SecondaryShowFlowClient 据此回 ACK） */
const navigate = async (pageId: string) => {
  const index = slidesStore.slides.findIndex(slide => slide.id === pageId)
  if (index === -1) throw new Error(`副屏文稿中不存在页面 ${pageId}`)
  slidesStore.updateSlideIndex(index)
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
}

let client: SecondaryShowFlowClient | null = null
let ws: WebSocket | null = null
let reconnectTimer = 0
const wsConnected = ref(false)
const controlled = ref(false)

const send = (msg: ShowFlowMessage) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...msg, role: 'secondary', sessionId: client?.sessionId ?? undefined }))
  }
}

const connect = () => {
  try {
    ws = new WebSocket(resolveShowFlowWsUrl())
  }
  catch {
    scheduleReconnect()
    return
  }
  ws.onopen = () => {
    wsConnected.value = true
    send({ type: 'HELLO', role: 'secondary', meta: { screen: 'pptist-remote', url: location.pathname } })
  }
  ws.onmessage = event => {
    try {
      client?.handleMessage(JSON.parse(event.data))
    }
    catch { /* 忽略非 JSON 帧 */ }
  }
  ws.onclose = () => {
    wsConnected.value = false
    controlled.value = false
    showFlowStore.setRemoteControlled(false)
    client?.reset()
    scheduleReconnect()
  }
  ws.onerror = () => ws?.close()
}

const scheduleReconnect = () => {
  if (reconnectTimer || syncStopped) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0
    connect()
  }, 2000)
}

client = new SecondaryShowFlowClient({
  send,
  navigate,
  onControlledChange: v => {
    controlled.value = v
    showFlowStore.setRemoteControlled(v)
  },
})

const statusLevel = computed(() => (wsConnected.value ? (controlled.value ? 'controlled' : 'connected') : 'offline'))
const statusText = computed(() => {
  if (!wsConnected.value) return '联动未连接（自由模式，可本机翻页）'
  return controlled.value ? '已连接 · 受控（ShowFlow 唯一时间轴）' : '已连接 · 等待控制'
})

const noop = () => {}

onMounted(() => {
  unsubscribe = subscribeSecondaryDocEvents({ onVersion: handleVersionNotice })
  syncLoop()
  connect()
})

onUnmounted(() => {
  syncStopped = true
  unsubscribe?.()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  ws?.close()
  showFlowStore.setRemoteControlled(false)
})
</script>

<style lang="scss" scoped>
.pptist-secondary {
  height: 100vh;
  background: #1d1d1d;
}

.placeholder {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #1a1a1e;
  color: #fff;

  .placeholder-main {
    max-width: 520px;
    text-align: center;
  }
  .placeholder-icon .icon {
    font-size: 56px;

    &.error { color: #e07b7b; }
  }
  .placeholder-text {
    font-size: 20px;
    margin: 16px 0 8px;
  }
  .placeholder-sub {
    font-size: 13px;
    color: #888;
    line-height: 1.6;
  }
  .retry-btn {
    margin-top: 18px;
    border: 1px solid rgba(255, 255, 255, .25);
    background: rgba(255, 255, 255, .08);
    color: #ddd;
    border-radius: 6px;
    font-size: 13px;
    padding: 6px 18px;
    cursor: pointer;

    &:hover { background: rgba(255, 255, 255, .16); }
  }
}

.status-chip {
  position: fixed;
  left: 12px;
  bottom: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 20px;
  background: rgba(20, 22, 28, .8);
  color: #aaa;
  font-size: 12px;
  backdrop-filter: blur(4px);

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #888;
  }
  &.connected .dot { background: #5b9bd5; }
  &.controlled {
    color: #d6e4ff;
    .dot { background: #2ecc71; }
  }
}
</style>
