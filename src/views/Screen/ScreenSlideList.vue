<template>
  <div class="screen-slide-list">
    <div 
      :class="[
        'slide-item', 
        `turning-mode-${slide.turningMode}`,
        {
          'current': index === slideIndex,
          'before': index < slideIndex,
          'after': index > slideIndex,
          'hide': (index === slideIndex - 1 || index === slideIndex + 1) && slide.turningMode !== slidesWithTurningMode[slideIndex].turningMode,
          'last': index === slideIndex - 1,
          'next': index === slideIndex + 1,
        }
      ]"
      v-for="(slide, index) in slidesWithTurningMode" 
      :key="slide.id"
    >
      <div 
        class="slide-content" 
        :style="{
          width: slideWidth + 'px',
          height: slideHeight + 'px',
        }"
        :data-gif-baked="bakedMark[index] || null"
        v-if="Math.abs(slideIndex - index) < 2"
      >
        <ScreenSlide 
          :slide="renderedSlide(index)" 
          :scale="scale"
          :animationIndex="animationIndex"
          :turnSlideToId="turnSlideToId"
          :manualExitFullscreen="manualExitFullscreen"
        />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, provide, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import { useShowFlowStore } from '@/show-flow/store'
import { isBakedImagePage } from '@/show-flow/monitor'
import { injectKeySlideScale } from '@/types/injectKey'
import useSlidesWithTurningMode from './hooks/useSlidesWithTurningMode'

import ScreenSlide from './ScreenSlide.vue'

const props = defineProps<{
  slideWidth: number
  slideHeight: number
  animationIndex: number
  turnSlideToId: (id: string) => void
  manualExitFullscreen: () => void
}>()

const { slideIndex, viewportSize } = storeToRefs(useSlidesStore())
const showFlowStore = useShowFlowStore()

const { slidesWithTurningMode } = useSlidesWithTurningMode()

// v3 页面标记：整页底图已烘焙 GIF 首帧。供空闲驻留 CSS（html.gif-parked）
// 精确隐藏 GIF 覆盖层而不影响普通页面。
const bakedMark = computed(() => slidesWithTurningMode.value.map(s => (isBakedImagePage(s) ? '1' : '')))

// 重资源邻居剥离生效条件：主屏联动硬切模式，或本窗口是受控副屏
// （remoteControlled 由 /secondary 页在收到导航时置位，与主屏 linkedScreening 等效）
const stripNeighborOverlays = computed(() => {
  const linkedHardCut = showFlowStore.linkedScreening && showFlowStore.flow.enabled && showFlowStore.flow.steps.length > 0
  return linkedHardCut || showFlowStore.remoteControlled
})

// 退场豁免：上一页在退出动画期间（≤900ms）仍可见，动画结束后才剥离其覆盖层；
// 当前页永不剥离。GIF/视频覆盖层（实测最大 134MB/个）若在 ±1 邻居页驻留挂载，
// 会与当前页同时解码，长演示把放映机内存拖垮（RK3588 约 30 分钟卡死实测）。
const lingeringIndex = ref(-1)
let settleTimer = 0
watch(slideIndex, (index, oldIndex) => {
  lingeringIndex.value = oldIndex ?? -1
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = window.setTimeout(() => { lingeringIndex.value = -1 }, 900)
})
onUnmounted(() => { if (settleTimer) clearTimeout(settleTimer) })

const renderedSlide = (index: number) => {
  const slide = slidesWithTurningMode.value[index]
  if (index === slideIndex.value || index === lingeringIndex.value || !stripNeighborOverlays.value) return slide
  // 邻居页剥离重资源覆盖层：GIF 图片与视频（baked 页底图已烘焙首帧，视觉无损；
  // 混排页邻居本身不可见，剥离同样不可感知）
  const elements = slide.elements?.filter(el => !(el.type === 'video' || (el.type === 'image' && /\.gif(\?|$)/i.test(el.src || ''))))
  return elements && elements.length !== slide.elements?.length ? { ...slide, elements } : slide
}

const scale = computed(() => props.slideWidth / viewportSize.value)
provide(injectKeySlideScale, scale)
</script>

<style lang="scss" scoped>
.screen-slide-list {
  background: #1d1d1d;
  position: relative;
  width: 100%;
  height: 100%;
}
.slide-item {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;

  &:not(.last, .next) {
    z-index: -1;
  }

  &.current {
    z-index: 2;
  }

  &.hide {
    opacity: 0;
  }

  &.turning-mode-no {
    &.before {
      transform: translateY(-100%);
    }
    &.after {
      transform: translateY(100%);
    }
  }
  &.turning-mode-fade {
    transition: opacity .75s;
    &.before {
      pointer-events: none;
      opacity: 0;
    }
    &.after {
      pointer-events: none;
      opacity: 0;
    }
  }
  &.turning-mode-slideX {
    transition: transform .35s;
    &.before {
      transform: translateX(-100%);
    }
    &.after {
      transform: translateX(100%);
    }
  }
  &.turning-mode-slideY {
    transition: transform .35s;
    &.before {
      transform: translateY(-100%);
    }
    &.after {
      transform: translateY(100%);
    }
  }
  &.turning-mode-slideX3D {
    transition: transform .5s;
    &.before {
      transform: translateX(-100%) scale(.5);
    }
    &.after {
      transform: translateX(100%) scale(.5);
    }
  }
  &.turning-mode-slideY3D {
    transition: transform .5s;
    &.before {
      transform: translateY(-100%) scale(.5);
    }
    &.after {
      transform: translateY(100%) scale(.5);
    }
  }
  &.turning-mode-rotate {
    transition: transform .5s;
    transform-origin: 0 0;
    &.before {
      transform: rotate(90deg);
    }
    &.after {
      transform: rotate(-90deg);
    }
  }
  &.turning-mode-scaleY {
    transition: transform .5s;
    &.before {
      transform: scaleY(.1);
    }
    &.after {
      transform: scaleY(.1);
    }
  }
  &.turning-mode-scaleX {
    transition: transform .5s;
    &.before {
      transform: scaleX(.1);
    }
    &.after {
      transform: scaleX(.1);
    }
  }
  &.turning-mode-scale {
    transition: transform .5s;
    &.before {
      transform: scale(.25);
    }
    &.after {
      transform: scale(.25);
    }
  }
  &.turning-mode-scaleReverse {
    transition: transform .5s;
    &.before {
      transform: scale(2);
    }
    &.after {
      transform: scale(2);
    }
  }
}
.slide-content {
  background-color: #fff;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  justify-content: center;
  align-items: center;
}
</style>
