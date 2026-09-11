<template>
  <!-- 联动放映运行时：不渲染任何界面（放映画面保持纯净）。
       负责监控截图上传与联动模式下的界面裁剪；翻页/退出走键盘与鼠标
       （方向键→虚拟步骤，ESC→结束放映），不依赖屏幕上的按钮。 -->
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useShowFlowStore } from '@/show-flow/store'
import { useSlidesStore } from '@/store'
import { captureAndUploadHalf } from '@/show-flow/monitor'

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
    await captureAndUploadHalf('main', el, slidesStore.slideIndex + 1, slidesStore.slides.length)
  }, 350)
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
</script>
