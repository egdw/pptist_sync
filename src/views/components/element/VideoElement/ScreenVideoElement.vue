<template>
  <div class="base-element-video screen-element-video"
    :style="{
      top: elementInfo.top + 'px',
      left: elementInfo.left + 'px',
      width: elementInfo.width + 'px',
      height: elementInfo.height + 'px',
    }"
  >
    <div
      class="rotate-wrapper"
      :style="{ transform: `rotate(${elementInfo.rotate}deg)` }"
    >
      <div class="element-content">
        <!-- autoplay 元素（GIF 转码视频）直通渲染：静音循环自动播放，无控制器、零 JS 开销，
             走 <video> 硬解码——超大 GIF（Chromium 动图解码上限内无法播放）由此获得流畅动画 -->
        <video
          v-if="elementInfo.autoplay && inCurrentSlide"
          class="auto-video"
          :src="elementInfo.src"
          :poster="elementInfo.poster"
          autoplay
          muted
          loop
          playsinline
          webkit-playsinline
          preload="auto"
        ></video>
        <VideoPlayer
          v-else-if="inCurrentSlide"
          :width="elementInfo.width"
          :height="elementInfo.height"
          :src="elementInfo.src"
          :poster="elementInfo.poster"
          :autoplay="elementInfo.autoplay"
          :scale="scale"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { PPTVideoElement } from '@/types/slides'
import { injectKeySlideId, injectKeySlideScale } from '@/types/injectKey'

import VideoPlayer from './VideoPlayer/index.vue'

defineProps<{
  elementInfo: PPTVideoElement
}>()

const { currentSlide } = storeToRefs(useSlidesStore())

const scale = inject(injectKeySlideScale) || ref(1)
const slideId = inject(injectKeySlideId) || ref('')

const inCurrentSlide = computed(() => currentSlide.value.id === slideId.value)
</script>

<style lang="scss" scoped>
.screen-element-video {
  position: absolute;
}
.auto-video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
}
.rotate-wrapper {
  width: 100%;
  height: 100%;
}
.element-content {
  width: 100%;
  height: 100%;
}
</style>
