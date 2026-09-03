<template>
  <div class="showflow-console" :class="{ collapsed }">
    <div class="console-head" @click="collapsed = !collapsed">
      <span class="dot" :class="phaseClass"></span>
      <span class="title">多屏联动</span>
      <span class="step-count">STEP {{ stepNo }} / {{ flow.steps.length }}</span>
      <span class="collapse-icon">{{ collapsed ? '▲' : '▼' }}</span>
    </div>

    <template v-if="!collapsed">
      <div class="console-body" v-if="currentStep">
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

        <div class="next-row" v-if="nextStep">
          下一步：{{ nextStep.label || nextTargetSummary(nextStep) }}
        </div>
        <div class="next-row end" v-else>已到最后一步</div>

        <div class="abnormal" v-if="phase === 'TRANSITIONING'">
          {{ flow.confirmationMode === 'strict' ? '等待确认中（严格模式）...' : '确认超时，宽松模式已放行' }}
        </div>

        <div class="online-bar">
          <span :class="{ on: true }">主屏 在线</span>
          <span :class="{ on: secondaryOnline }">副屏 {{ secondaryOnline ? '在线' : '离线' }}</span>
        </div>

        <div class="actions">
          <button @click="showFlowStore.next()">→ 下一步</button>
          <button @click="showFlowStore.previous()">← 上一步</button>
          <button @click="showFlowStore.resendCurrentStep()">重发</button>
          <button @click="showFlowStore.resyncAllScreens()">重同步</button>
          <button @click="showFlowStore.forceCompleteStep()">强制完成</button>
          <button @click="showFlowStore.skipSecondaryScreen()">跳过副屏</button>
          <button class="danger" @click="exitFlow">退出联动</button>
        </div>
        <div class="hint">方向键 / 滚轮按虚拟步骤推进，与真实页码无关</div>
      </div>
      <div class="console-body" v-else>
        <div class="hint">尚未开始：按 → 执行 Step 1</div>
        <div class="actions">
          <button @click="showFlowStore.next()">→ 开始</button>
          <button class="danger" @click="exitFlow">退出联动</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useShowFlowStore } from '@/show-flow/store'
import type { ShowStep } from '@/show-flow/types'
import message from '@/utils/message'

const showFlowStore = useShowFlowStore()
const { flow, phase, snapshot, currentStepIndex, online } = storeToRefs(showFlowStore)

const collapsed = ref(false)

const currentStep = computed<ShowStep | null>(() => flow.value.steps[currentStepIndex.value] ?? null)
const nextStep = computed<ShowStep | null>(() => flow.value.steps[currentStepIndex.value + 1] ?? null)
const stepNo = computed(() => (currentStepIndex.value >= 0 ? currentStepIndex.value + 1 : 0))

const phaseClass = computed(() => ({
  ready: phase.value === 'READY',
  transitioning: phase.value === 'TRANSITIONING',
}))

const secondaryOnline = computed(() => online.value.secondary)

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

// 中途关闭联动时收起控制台
watch(() => flow.value.enabled, enabled => {
  if (!enabled) collapsed.value = true
})
</script>

<style lang="scss" scoped>
.showflow-console {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 100;
  width: 320px;
  background: rgba(20, 22, 28, .92);
  border-radius: 10px;
  color: #ddd;
  font-size: 13px;
  backdrop-filter: blur(4px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, .35);
  overflow: hidden;
}

.console-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  user-select: none;

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #888;
    &.ready { background: #2ecc71; }
    &.transitioning { background: #f39c12; animation: blink 1s infinite; }
  }
  .title { font-weight: 600; }
  .step-count { flex: 1; color: #9aa0ad; font-size: 12px; }
  .collapse-icon { font-size: 10px; color: #9aa0ad; }
}

@keyframes blink {
  50% { opacity: .3; }
}

.console-body {
  padding: 4px 12px 12px;
}

.target-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, .05);
  margin-bottom: 5px;
  color: #777;

  &.active { color: #eee; }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status { font-size: 12px; color: #2ecc71; }
}

.role {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;

  &.main { background: #5b9bd5; }
  &.secondary { background: #f0a04b; }
  &.tablet { background: #9c6cd4; }
}

.next-row {
  padding: 6px 8px 0;
  font-size: 12px;
  color: #9aa0ad;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.end { color: #666; }
}

.abnormal {
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(243, 156, 18, .15);
  color: #f3b04b;
  font-size: 12px;
}

.online-bar {
  display: flex;
  gap: 12px;
  padding: 6px 8px 0;
  font-size: 11px;

  span { color: #666; }
  span.on { color: #2ecc71; }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;

  button {
    border: 1px solid rgba(255, 255, 255, .18);
    background: rgba(255, 255, 255, .07);
    color: #ddd;
    border-radius: 5px;
    font-size: 12px;
    padding: 4px 9px;
    cursor: pointer;

    &:hover { background: rgba(255, 255, 255, .14); }
    &.danger:hover { border-color: #e07b7b; color: #e07b7b; }
  }
}

.hint {
  margin-top: 7px;
  font-size: 11px;
  color: #666;
}
</style>
