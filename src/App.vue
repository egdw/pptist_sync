<template>
  <PlayView v-if="isPlayRoute && !isAudienceMode" />
  <UploadView v-else-if="isUploadRoute && !isAudienceMode" />
  <SecondaryView v-else-if="isSecondaryRoute && !isAudienceMode" />
  <ShowFlowView v-else-if="isShowFlowRoute && !isAudienceMode && slides.length && !screening" />
  <template v-else>
    <template v-if="slides.length">
      <Screen v-if="screening" />
      <Editor v-else-if="_isPC" />
      <Mobile v-else />
    </template>
    <FullscreenSpin tip="数据初始化中，请稍等 ..." v-else  loading :mask="false" />
  </template>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import { nanoid } from 'nanoid'
import { useScreenStore, useMainStore, useSnapshotStore, useSlidesStore } from '@/store'
import { LOCALSTORAGE_KEY_DISCARDED_DB } from '@/configs/storage'
import { deleteDiscardedDB } from '@/utils/database'
import { isPC } from '@/utils/common'
import { initPresentationBridge, destroyPresentationBridge } from '@/utils/presentation/bridge'
import { useShowFlowStore } from '@/show-flow/store'
import { applyBundleToSlidesStore, fetchDefaultPptCurrent, fetchDefaultPptSlides } from '@/services/defaultPpt'
import api from '@/services'

import Editor from './views/Editor/index.vue'
import Screen from './views/Screen/index.vue'
import Mobile from './views/Mobile/index.vue'
import PlayView from './views/Play/index.vue'
import UploadView from './views/Upload/index.vue'
import ShowFlowView from './views/ShowFlow/index.vue'
import SecondaryView from './views/Secondary/index.vue'
import FullscreenSpin from '@/components/FullscreenSpin.vue'

const _isPC = isPC()

const mainStore = useMainStore()
const slidesStore = useSlidesStore()
const snapshotStore = useSnapshotStore()
const screenStore = useScreenStore()
const { databaseId } = storeToRefs(mainStore)
const { slides } = storeToRefs(slidesStore)
const { screening } = storeToRefs(screenStore)

const isAudienceMode = new URLSearchParams(window.location.search).get('mode') === 'audience'

// 路径分发：/play 为「打开即放映」的播放页；/upload 为远程上传管理页；
// 其余路径（含 /，即原有入口）保持原有编辑器行为。观众窗口优先走原有逻辑。
const routePath = window.location.pathname.replace(/\/+$/, '') || '/'
const isPlayRoute = routePath === '/play'
const isUploadRoute = routePath === '/upload'
const isShowFlowRoute = routePath === '/showflow'
// 双 PPTist 模式的副屏（PPTist B）只读播放页：自行加载服务端上传文稿
const isSecondaryRoute = routePath === '/secondary'

if (import.meta.env.MODE !== 'development') {
  window.onbeforeunload = () => false
}

// 放映联动：主控窗口挂载一次（观众窗口自动跳过），随应用卸载清理
if (!isAudienceMode) initPresentationBridge()
onUnmounted(() => destroyPresentationBridge())

// 多屏联动（ShowFlow）：非观众窗口初始化一次（WS 连接、源清单对账）；
// /secondary 副屏页例外 —— 它是受控端，只运行 SecondaryShowFlowClient，不能注册 controller 角色
const showFlowStore = useShowFlowStore()
onMounted(() => {
  if (!isAudienceMode && !isSecondaryRoute) showFlowStore.init()
})

onMounted(async () => {
  if (isAudienceMode) {
    slidesStore.setSlides([{
      id: nanoid(10),
      elements: [],
    }])
    screenStore.setScreening(true)
  }
  else if (isPlayRoute || isUploadRoute || isSecondaryRoute) {
    // 播放页 / 上传页 / 副屏页自行管理文稿加载，不加载示例 PPT，不初始化编辑器快照数据库
  }
  else {
    // 编辑器与大屏播放页对齐：服务端存在默认 PPT 时加载同一份文稿，
    // 否则回退到原有示例数据（服务端不可达时也不影响编辑器使用）
    let restored = false
    try {
      const meta = await fetchDefaultPptCurrent()
      if (meta.exists) {
        const { bundle } = await fetchDefaultPptSlides()
        applyBundleToSlidesStore(bundle)
        restored = true
      }
    }
    catch { /* 服务端不可达：回退示例数据 */ }
    if (!restored) {
      const slides = await api.getMockData('slides')
      slidesStore.setSlides(slides)
    }

    await deleteDiscardedDB()
    snapshotStore.initSnapshotDatabase()
  }
})

// 应用注销时向 localStorage 中记录下本次 indexedDB 的数据库ID，用于之后清除数据库
window.addEventListener('beforeunload', () => {
  const discardedDB = localStorage.getItem(LOCALSTORAGE_KEY_DISCARDED_DB)
  const discardedDBList: string[] = discardedDB ? JSON.parse(discardedDB) : []

  discardedDBList.push(databaseId.value)

  const newDiscardedDB = JSON.stringify(discardedDBList)
  localStorage.setItem(LOCALSTORAGE_KEY_DISCARDED_DB, newDiscardedDB)
})
</script>

<style lang="scss">
#app {
  height: 100%;
}
</style>