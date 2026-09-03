<template>
  <div class="pptist-screen">
    <AudienceView v-if="isAudienceMode" />
    <BaseView :changeViewMode="changeViewMode" v-else-if="viewMode === 'base'" />
    <PresenterView :changeViewMode="changeViewMode" v-else-if="viewMode === 'presenter'" />
    <ShowFlowConsole v-if="!isAudienceMode && showFlowStore.flow.enabled" />
  </div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { KEYS } from '@/configs/hotkey'
import useScreening from '@/hooks/useScreening'
import { useShowFlowStore } from '@/show-flow/store'

import AudienceView from './AudienceView.vue'
import BaseView from './BaseView.vue'
import PresenterView from './PresenterView.vue'
import ShowFlowConsole from './ShowFlowConsole.vue'

const isAudienceMode = new URLSearchParams(window.location.search).get('mode') === 'audience'

const showFlowStore = useShowFlowStore()

const viewMode = ref<'base' | 'presenter'>('base')

const changeViewMode = (mode: 'base' | 'presenter') => {
  viewMode.value = mode
}

const { exitScreening: _exitScreening } = useScreening()

const syncChannel = !isAudienceMode ? new BroadcastChannel('pptist-audience-sync') : null

const exitScreening = () => {
  syncChannel?.postMessage({ type: 'EXIT' })
  if (showFlowStore.flow.enabled) showFlowStore.stopShow()
  _exitScreening()
}

// 快捷键退出放映（观众视图中 ESC 不响应，由用户直接关闭窗口）
const keydownListener = (e: KeyboardEvent) => {
  const key = e.key.toUpperCase()
  if (key === KEYS.ESC) exitScreening()
}

onMounted(() => {
  if (!isAudienceMode) document.addEventListener('keydown', keydownListener)
  // 联动模式下进入放映即开始虚拟步骤会话
  if (!isAudienceMode && showFlowStore.flow.enabled) showFlowStore.startShow()
})
onUnmounted(() => {
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
