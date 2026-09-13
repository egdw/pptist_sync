<template>
  <div class="pptist-screen">
    <AudienceView v-if="isAudienceMode" />
    <BaseView :changeViewMode="changeViewMode" clickToAdvance v-else-if="viewMode === 'base'" />
    <PresenterView :changeViewMode="changeViewMode" v-else-if="viewMode === 'presenter'" />
    <!-- 联动会话只在编排页「开始联动放映」发起；首页/编辑器的普通测试放映不挂任何联动逻辑 -->
    <ShowFlowRuntime v-if="linkedSession" />
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { KEYS } from '@/configs/hotkey'
import useScreening from '@/hooks/useScreening'
import { useShowFlowStore } from '@/show-flow/store'

import AudienceView from './AudienceView.vue'
import BaseView from './BaseView.vue'
import PresenterView from './PresenterView.vue'
import ShowFlowRuntime from './ShowFlowRuntime.vue'

const isAudienceMode = new URLSearchParams(window.location.search).get('mode') === 'audience'

const showFlowStore = useShowFlowStore()

/** 本次会话为联动放映（编排页按钮一次性置位）且方案开关开启 */
const linkedSession = computed(() => showFlowStore.linkedScreening && showFlowStore.flow.enabled)

const viewMode = ref<'base' | 'presenter'>('base')

const changeViewMode = (mode: 'base' | 'presenter') => {
  viewMode.value = mode
}

const { exitScreening: _exitScreening } = useScreening()

const syncChannel = !isAudienceMode ? new BroadcastChannel('pptist-audience-sync') : null

const exitScreening = () => {
  syncChannel?.postMessage({ type: 'EXIT' })
  if (linkedSession.value) showFlowStore.stopShow()
  _exitScreening()
}

// 快捷键退出放映（观众视图中 ESC 不响应，由用户直接关闭窗口）
const keydownListener = (e: KeyboardEvent) => {
  const key = e.key.toUpperCase()
  if (key === KEYS.ESC) exitScreening()
}

onMounted(() => {
  if (!isAudienceMode) document.addEventListener('keydown', keydownListener)
  // 联动会话：进入放映即开始虚拟步骤会话（普通放映完全不触发）
  if (linkedSession.value) showFlowStore.startShow()
})
onUnmounted(() => {
  if (linkedSession.value) showFlowStore.stopShow()
  if (!isAudienceMode) document.removeEventListener('keydown', keydownListener)
  syncChannel?.close()
})
</script>

<style lang="scss" scoped>
.pptist-screen {
  width: 100%;
  height: 100%;
}
</style>
