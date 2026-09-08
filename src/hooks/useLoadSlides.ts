import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'

export default () => {
  const { slides, slideIndex } = storeToRefs(useSlidesStore())

  // 挂载窗口锚定当前页：只挂当前页附近的缩略图，不再随时间渐进加载全部页面。
  // 初始给足首屏缓冲；播放/跳页时窗口随之移动，从未到达的远端页保持占位，
  // 避免大文稿打开后所有页面的图片（含 GIF）被陆续挂载解码。
  const BASE_LIMIT = 40
  const LOOKAHEAD = 30
  const slidesLoadLimit = computed(() => Math.min(
    slides.value.length,
    Math.max(BASE_LIMIT, slideIndex.value + LOOKAHEAD),
  ))

  return {
    slidesLoadLimit,
  }
}
