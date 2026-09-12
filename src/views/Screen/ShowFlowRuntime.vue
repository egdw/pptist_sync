<template>
  <!-- 联动放映运行时：不渲染任何界面（放映画面保持纯净）。
       负责监控截图上传与联动模式下的界面裁剪；翻页/退出走键盘与鼠标
       （方向键→虚拟步骤，ESC→结束放映），不依赖屏幕上的按钮。 -->
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useShowFlowStore } from '@/show-flow/store'
import { useSlidesStore } from '@/store'
import { captureAndUploadHalf, isBakedImagePage } from '@/show-flow/monitor'

const showFlowStore = useShowFlowStore()

// ---- 双 PPT 合成监控：主屏页变化(含首次)自动截图上传，与副屏合成 1280×800 ----
const screenEl = () => document.querySelector('.screen-slide-list .slide-item.current .slide-content')
let monitorTimer = 0
const scheduleMonitorUpload = () => {
  if (monitorTimer) clearTimeout(monitorTimer)
  monitorTimer = window.setTimeout(async () => {
    const el = screenEl()
    if (!el) return
    const slidesStore = useSlidesStore()
    const slide = slidesStore.slides[slidesStore.slideIndex]
    // v3 整页底图已烘焙 GIF 首帧：截图跳过 GIF 动图，避免把超大动图 base64 进 SVG
    await captureAndUploadHalf('main', el, slidesStore.slideIndex + 1, slidesStore.slides.length, {
      skipGifOverlays: isBakedImagePage(slide),
    })
  }, 200)
}
onMounted(() => {
  // 首帧渲染完成后上传一次（联动放映「初次打开」）
  scheduleMonitorUpload()
})
onUnmounted(() => {
  if (monitorTimer) clearTimeout(monitorTimer)
})
watch(() => useSlidesStore().slideIndex, scheduleMonitorUpload)

// 联动模式下隐藏主屏左下角手动‹›按钮（翻页由虚拟步骤接管）
watch(() => showFlowStore.flow.enabled, enabled => {
  document.documentElement.classList.toggle('showflow-active', enabled)
}, { immediate: true })
onUnmounted(() => {
  document.documentElement.classList.remove('showflow-active')
})

// ---- 空闲驻留：长时间无操作时停播 GIF，防止长驻页面拖垮放映机 ----
// 大 GIF（实测单页最大 134MB，解码驻留 +500MB+）循环播放是空闲卡死的
// 主要内存压力；v3 页面底图已烘焙 GIF 首帧，驻留时隐藏覆盖层视觉无损，
// 任意键鼠操作立即恢复动图。
const GIF_PARK_IDLE_MS = 5 * 60 * 1000
let lastActivityAt = Date.now()
const activityEvents = ['keydown', 'pointerdown', 'mousemove', 'wheel'] as const
const markActivity = () => {
  lastActivityAt = Date.now()
  document.documentElement.classList.remove('gif-parked')
}
let parkTimer = 0
onMounted(() => {
  for (const type of activityEvents) window.addEventListener(type, markActivity, { passive: true })
  parkTimer = window.setInterval(() => {
    if (Date.now() - lastActivityAt >= GIF_PARK_IDLE_MS) document.documentElement.classList.add('gif-parked')
  }, 10_000)
})
onUnmounted(() => {
  for (const type of activityEvents) window.removeEventListener(type, markActivity)
  if (parkTimer) clearInterval(parkTimer)
  document.documentElement.classList.remove('gif-parked')
})
</script>
