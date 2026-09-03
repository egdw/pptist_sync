<template>
  <div class="showflow-console" :class="{ collapsed, hovered }" @mouseenter="hovered = true" @mouseleave="hovered = false">
    <!-- 迷你条：默认仅显示此行，不干扰放映 -->
    <div class="mini-bar" @click="collapsed = !collapsed">
      <span class="dot" :class="phaseClass"></span>
      <span class="mini-step">{{ stepNo }}/{{ flow.steps.length }}</span>
      <span class="mini-main">{{ miniMain }}</span>
      <span class="mini-sec" :class="{ off: !secondaryOnline && !!snapshot?.secondaryPageId }">{{ miniSec }}</span>
    </div>

    <!-- 完整面板：悬停或手动展开时显示 -->
    <div class="console-panel" v-show="!collapsed || hovered">
      <div class="panel-head">
        <span class="title">多屏联动</span>
        <span class="step-count">STEP {{ stepNo }} / {{ flow.steps.length }}</span>
        <span class="collapse-icon" @click="collapsed = !collapsed">{{ collapsed ? '▲' : '▼' }}</span>
      </div>

      <div class="panel-body" v-if="currentStep">
        <div class="target-row" :class="{ active: !!snapshot?.mainPageId }">
          <span class="role main">主</span>
          <span class="name">{{ mainTitle }}</span>
          <span class="status" v-if="snapshot?.mainPageId">✓</span>
        </div>
        <div class="target-row" :class="{ active: !!snapshot?.secondaryPageId }">
          <span class="role secondary">副</span>
          <span class="name">{{ secondaryTitle }}</span>
          <span class="status" v-if="snapshot?.secondaryPageId">{{ secondaryOnline ? '✓' : '离线' }}</span>
        </div>
        <div class="target-row" v-if="snapshot?.tabletScene" :class="{ active: true }">
          <span class="role tablet">板</span>
          <span class="name">{{ snapshot.tabletScene }}</span>
          <span class="status">✓</span>
        </div>

        <div class="next-row" v-if="nextStep">下一步：{{ nextStep.label || nextTargetSummary(nextStep) }}</div>
        <div class="next-row end" v-else>已到最后一步</div>

        <div class="abnormal" v-if="phase === 'TRANSITIONING'">
          {{ flow.confirmationMode === 'strict' ? '等待确认中...' : '确认超时，已放行' }}
        </div>

        <div class="actions">
          <button @click="showFlowStore.next()">→</button>
          <button @click="showFlowStore.previous()">←</button>
          <button @click="showFlowStore.resendCurrentStep()">重发</button>
          <button @click="showFlowStore.resyncAllScreens()">同步</button>
          <button @click="showFlowStore.forceCompleteStep()">强完</button>
          <button @click="showFlowStore.skipSecondaryScreen()">跳副</button>
          <button class="danger" @click="exitFlow">退出</button>
        </div>
      </div>
      <div class="panel-body" v-else>
        <div class="next-row">按 → 执行 Step 1</div>
        <div class="actions">
          <button @click="showFlowStore.next()">→ 开始</button>
          <button class="danger" @click="exitFlow">退出</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useShowFlowStore } from '@/show-flow/store'
import { useSlidesStore } from '@/store'
import type { ShowStep } from '@/show-flow/types'
import message from '@/utils/message'
import { captureAndUploadHalf } from '@/show-flow/monitor'

const showFlowStore = useShowFlowStore()
const slidesStore = useSlidesStore()
const { flow, phase, snapshot, currentStepIndex, online } = storeToRefs(showFlowStore)

/** 默认收起：放映时仅保留迷你条 */
const collapsed = ref(true)
const hovered = ref(false)

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
  window.setTimeout(scheduleMonitorUpload, 1500)
})
onUnmounted(() => { if (monitorTimer) clearTimeout(monitorTimer) })
watch(() => showFlowStore.snapshot, () => {
  // 每个虚拟步骤应用后上传最新主屏画面
  window.setTimeout(scheduleMonitorUpload, 700)
})

const currentStep = computed<ShowStep | null>(() => flow.value.steps[currentStepIndex.value] ?? null)
const nextStep = computed<ShowStep | null>(() => flow.value.steps[currentStepIndex.value + 1] ?? null)
const stepNo = computed(() => (currentStepIndex.value >= 0 ? currentStepIndex.value + 1 : 0))

const phaseClass = computed(() => ({
  ready: phase.value === 'READY',
  transitioning: phase.value === 'TRANSITIONING',
}))

const secondaryOnline = computed(() => online.value.secondary)

// ---- 迷你条超简文本 ----
const miniMain = computed(() => {
  if (!snapshot.value?.mainPageId) return '主·'
  const t = mainTitle.value
  return t.length > 6 ? '主:' + t.slice(0, 6) : '主:' + t
})
const miniSec = computed(() => {
  if (!snapshot.value?.secondaryPageId) return '副·'
  const t = secondaryTitle.value
  const s = t.length > 6 ? '副:' + t.slice(0, 6) : '副:' + t
  return s
})

const mainTitle = computed(() => {
  if (!snapshot.value?.mainPageId) return '保持'
  const hit = showFlowStore.mainManifest.find(p => p.id === snapshot.value?.mainPageId)
  return hit?.title || snapshot.value.mainPageId
})
const secondaryTitle = computed(() => {
  if (!snapshot.value?.secondaryPageId) return '保持'
  const hit = showFlowStore.secondaryManifest.find(p => p.id === snapshot.value?.secondaryPageId)
  return hit?.title || snapshot.value.secondaryPageId
})

const nextTargetSummary = (step: ShowStep) => {
  const parts: string[] = []
  if (step.main?.action === 'goto') {
    parts.push('主:' + (showFlowStore.mainManifest.find(p => p.id === step.main?.pageId)?.title || step.main.pageId))
  }
  if (step.secondary?.action === 'goto') {
    parts.push('副:' + (showFlowStore.secondaryManifest.find(p => p.id === step.secondary?.pageId)?.title || step.secondary.pageId))
  }
  if (step.tablet?.scene) parts.push('平板:' + step.tablet.scene)
  return parts.join(' + ') || '（无操作步骤）'
}

const exitFlow = () => {
  showFlowStore.setEnabled(false)
  message.success('已退出多屏联动，恢复普通放映模式')
}

// 联动模式下隐藏主屏左下角手动‹›按钮（翻页由虚拟步骤接管，控制台底部已有 ‹/›）
watch(() => flow.value.enabled, enabled => {
  document.documentElement.classList.toggle('showflow-active', enabled)
}, { immediate: true })

// 中途关闭联动时收起控制台
watch(() => flow.value.enabled, enabled => {
  if (!enabled) collapsed.value = true
})
</script>

<style lang="scss" scoped>
.showflow-console {
  position: fixed;
  right: 10px;
  bottom: 10px;
  z-index: 100;
  color: #ccc;
  font-size: 11px;
  opacity: .55;
  transition: opacity .25s;

  &:hover {
    opacity: 1;
  }
}

/* —— 迷你条 —— */
.mini-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 12px;
  background: rgba(18, 20, 26, .6);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  line-height: 1.4;

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #888;
    flex-shrink: 0;
    &.ready { background: #2ecc71; }
    &.transitioning { background: #f39c12; animation: blink 1s infinite; }
  }
  .mini-step { font-weight: 600; color: #9aa0ad; }
  .mini-main, .mini-sec { color: #8892a0; max-width: 90px; overflow: hidden; text-overflow: ellipsis; }
  .mini-sec.off { color: #e07b7b; }
}

@keyframes blink {
  50% { opacity: .3; }
}

/* —— 完整面板（悬停/展开时） —— */
.console-panel {
  margin-top: 4px;
  width: 232px;
  background: rgba(18, 20, 26, .88);
  border-radius: 8px;
  backdrop-filter: blur(4px);
  box-shadow: 0 3px 14px rgba(0, 0, 0, .3);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  cursor: pointer;
  user-select: none;

  .title { font-weight: 600; font-size: 11px; }
  .step-count { flex: 1; color: #9aa0ad; font-size: 10px; }
  .collapse-icon { font-size: 9px; color: #9aa0ad; }
}

.panel-body {
  padding: 0 8px 8px;
}

.target-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  background: rgba(255, 255, 255, .05);
  margin-bottom: 3px;
  color: #777;

  &.active { color: #ddd; }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status { font-size: 10px; color: #2ecc71; }
}

.role {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 3px;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;

  &.main { background: #5b9bd5; }
  &.secondary { background: #f0a04b; }
  &.tablet { background: #9c6cd4; }
}

.next-row {
  padding: 4px 6px 0;
  font-size: 10px;
  color: #9aa0ad;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.end { color: #666; }
}

.abnormal {
  margin-top: 4px;
  padding: 3px 6px;
  border-radius: 5px;
  background: rgba(243, 156, 18, .15);
  color: #f3b04b;
  font-size: 10px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;

  button {
    border: 1px solid rgba(255, 255, 255, .16);
    background: rgba(255, 255, 255, .06);
    color: #ccc;
    border-radius: 4px;
    font-size: 10px;
    padding: 2px 7px;
    cursor: pointer;

    &:hover { background: rgba(255, 255, 255, .14); }
    &.danger:hover { border-color: #e07b7b; color: #e07b7b; }
  }
}
</style>
