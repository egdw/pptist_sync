<template>
  <div class="show-flow-editor">
    <header class="header">
      <div class="left">
        <Input
          class="flow-name"
          :value="flow.name"
          @update:value="(v: string) => updateFlowMeta({ name: v })"
          placeholder="流程名称"
        />
        <div class="switch-item">
          <Switch :value="flow.enabled" @update:value="v => showFlowStore.setEnabled(v)" />
          <span>启用多屏联动</span>
        </div>
        <div class="switch-item">
          <Switch :value="flow.confirmationEnabled" @update:value="v => updateFlowMeta({ confirmationEnabled: v })" />
          <span>切换确认</span>
        </div>
        <Select
          class="mode-select"
          :value="flow.confirmationMode"
          :options="[
            { label: '严格模式（全部 ACK）', value: 'strict' },
            { label: '宽松模式（超时放行）', value: 'loose' },
          ]"
          @update:value="v => updateFlowMeta({ confirmationMode: v as 'strict' | 'loose' })"
        />
      </div>
      <div class="right">
        <span class="ws-status" :class="{ online: wsConnected }">{{ wsConnected ? '控制服务已连接' : '控制服务未连接' }}</span>
        <Button size="small" @click="openSecondaryScreen">打开副屏页</Button>
        <Button size="small" @click="showFlowStore.refreshSecondaryManifest(); showFlowStore.reconcile('secondary')">刷新副屏清单</Button>
        <Button size="small" type="primary" @click="enterScreeningWithFlow">开始联动放映</Button>
      </div>
    </header>

    <div class="secondary-config">
      <span class="label">副屏来源：</span>
      <Input
        class="md-path"
        :value="secondarySource?.mdPath || ''"
        @update:value="(v: string) => showFlowStore.updateSecondarySource({ mdPath: v })"
        placeholder="Reveal Markdown 路径，如 /reveal/slides.md"
      />
      <span v-if="secondaryManifestError" class="error">{{ secondaryManifestError }}</span>
      <span v-else class="meta">共 {{ secondaryManifest.length }} 页</span>
    </div>

    <main class="columns">
      <!-- 左：主屏页面池 -->
      <section class="pool">
        <div class="pool-title">主屏页面池（PPTist 当前文稿）</div>
        <div class="pool-list">
          <div
            v-for="page in mainManifest"
            :key="page.id"
            class="pool-item"
            :class="{ used: mainUsedIds.has(page.id) }"
            draggable="true"
            :data-transfer="transferData('main', page.id)"
            @dragstart="onPageDragStart($event, 'main', page.id)"
            @click="showFlowStore.addPageToStep('main', page.id)"
          >
            <span class="page-index">{{ page.index }}</span>
            <span class="page-title" :title="page.notes">{{ page.title }}</span>
            <span class="page-badge" v-if="mainStepNo(page.id)">Step {{ mainStepNo(page.id) }}</span>
          </div>
          <div v-if="!mainManifest.length" class="empty">主屏暂无页面</div>
        </div>
        <div class="pool-tip">点击页面 → 追加到序列末尾；拖拽 → 放到指定位置 / 合并进已有步骤</div>
      </section>

      <!-- 中：虚拟播放序列 -->
      <section class="sequence">
        <div class="seq-title">虚拟播放序列（{{ flow.steps.length }} 步）</div>
        <div class="seq-list" @dragover.prevent @drop="onDropGap(flow.steps.length, $event)">
          <template v-for="(step, i) in flow.steps" :key="step.id">
            <div class="gap" @dragover.prevent @drop.stop="onDropGap(i, $event)"></div>
            <div
              class="step-card"
              :class="{
                current: snapshot?.stepId === step.id,
                'main-only': step.main?.action === 'goto' && step.secondary?.action !== 'goto',
                'secondary-only': step.secondary?.action === 'goto' && step.main?.action !== 'goto',
                sync: step.main?.action === 'goto' && step.secondary?.action === 'goto',
                event: step.main?.action !== 'goto' && step.secondary?.action !== 'goto',
              }"
              draggable="true"
              @dragstart="onStepDragStart($event, i)"
              @dragover.prevent
              @drop.stop.prevent="onDropStep(i, $event)"
            >
              <div class="step-head">
                <span class="step-no">Step {{ i + 1 }}</span>
                <input
                  class="step-label"
                  :value="step.label || ''"
                  placeholder="步骤名（可选）"
                  @change="renameStep(step.id, ($event.target as HTMLInputElement).value)"
                />
                <span class="kind-tag">{{ stepKindLabel(step) }}</span>
              </div>
              <div class="step-targets">
                <div class="target main" :class="{ active: step.main?.action === 'goto' }">
                  <span class="role">主</span>
                  <span class="title">{{ mainTargetTitle(step) }}</span>
                  <button v-if="step.main?.action === 'goto'" class="clear" title="清除主屏引用" @click="showFlowStore.removePageFromStep('main', step.id)">×</button>
                </div>
                <div class="target secondary" :class="{ active: step.secondary?.action === 'goto' }">
                  <span class="role">副</span>
                  <span class="title">{{ secondaryTargetTitle(step) }}</span>
                  <button v-if="step.secondary?.action === 'goto'" class="clear" title="清除副屏引用" @click="showFlowStore.removePageFromStep('secondary', step.id)">×</button>
                </div>
              </div>
              <div class="step-actions">
                <button @click="showFlowStore.duplicateStep(step.id)">复制</button>
                <button class="danger" @click="showFlowStore.removeStep(step.id)">删除</button>
              </div>
            </div>
          </template>
          <div class="gap last" @dragover.prevent @drop.stop="onDropGap(flow.steps.length, $event)"></div>
          <div v-if="!flow.steps.length" class="empty">点击或拖拽左右两侧页面开始编排</div>
        </div>
      </section>

      <!-- 右：副屏页面池 -->
      <section class="pool">
        <div class="pool-title">副屏页面池（Reveal / Markdown）</div>
        <div class="pool-list">
          <div
            v-for="page in secondaryManifest"
            :key="page.id"
            class="pool-item"
            :class="{ used: secondaryUsedIds.has(page.id) }"
            draggable="true"
            @dragstart="onPageDragStart($event, 'secondary', page.id)"
            @click="showFlowStore.addPageToStep('secondary', page.id)"
          >
            <span class="page-index">{{ page.index }}</span>
            <span class="page-title" :title="page.stage">{{ page.title }}</span>
            <span class="page-badge" v-if="secondaryStepNo(page.id)">Step {{ secondaryStepNo(page.id) }}</span>
          </div>
          <div v-if="!secondaryManifest.length" class="empty">
            {{ secondaryManifestError || '未加载到副屏页面，请检查上方 MD 路径' }}
          </div>
        </div>
        <div class="pool-tip">页 id 来自 data-page-id（未标注时按内容稳定 hash 生成，建议显式标注）</div>
      </section>
    </main>

    <footer class="report" v-if="lastReport">
      源同步结果 —— 保留 {{ lastReport.kept }} · 新增 {{ lastReport.added }} · 引用移除 {{ lastReport.removedNodeRefs }} · 步骤移除 {{ lastReport.removedSteps.length }}
      <button class="dismiss" @click="dismissReport">×</button>
    </footer>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useShowFlowStore } from '@/show-flow/store'
import useScreening from '@/hooks/useScreening'
import type { ShowStep } from '@/show-flow/types'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'

const showFlowStore = useShowFlowStore()
const { flow, sources, mainManifest, secondaryManifest, secondaryManifestError, snapshot, wsConnected, lastReport } = storeToRefs(showFlowStore)

const mainSource = computed(() => sources.value.find(s => s.role === 'main'))
const secondarySource = computed(() => sources.value.find(s => s.role === 'secondary'))

const mainUsedIds = computed(() => new Set(flow.value.steps.map(s => s.main?.pageId).filter(Boolean) as string[]))
const secondaryUsedIds = computed(() => new Set(flow.value.steps.map(s => s.secondary?.pageId).filter(Boolean) as string[]))

const mainStepNo = (pageId: string) => {
  const i = flow.value.steps.findIndex(s => s.main?.pageId === pageId)
  return i === -1 ? '' : i + 1
}
const secondaryStepNo = (pageId: string) => {
  const i = flow.value.steps.findIndex(s => s.secondary?.pageId === pageId)
  return i === -1 ? '' : i + 1
}

const mainTitleById = computed(() => new Map(mainManifest.value.map(p => [p.id, p.title])))
const secondaryTitleById = computed(() => new Map(secondaryManifest.value.map(p => [p.id, p.title])))

const mainTargetTitle = (step: ShowStep) =>
  step.main?.action === 'goto' && step.main.pageId
    ? mainTitleById.value.get(step.main.pageId) || `（页面已删除 ${step.main.pageId}）`
    : '保持'
const secondaryTargetTitle = (step: ShowStep) =>
  step.secondary?.action === 'goto' && step.secondary.pageId
    ? secondaryTitleById.value.get(step.secondary.pageId) || `（页面已删除 ${step.secondary.pageId}）`
    : '保持'

const stepKindLabel = (step: ShowStep) => {
  const main = step.main?.action === 'goto'
  const secondary = step.secondary?.action === 'goto'
  if (main && secondary) return '同步'
  if (main) return '仅主屏'
  if (secondary) return '仅副屏'
  return '事件'
}

const transferData = (role: 'main' | 'secondary', pageId: string) => JSON.stringify({ kind: 'page', role, pageId })

const onPageDragStart = (e: DragEvent, role: 'main' | 'secondary', pageId: string) => {
  e.dataTransfer?.setData('application/x-show-flow', transferData(role, pageId))
}
const onStepDragStart = (e: DragEvent, index: number) => {
  e.dataTransfer?.setData('application/x-show-flow', JSON.stringify({ kind: 'step', index }))
}

const readTransfer = (e: DragEvent) => {
  const raw = e.dataTransfer?.getData('application/x-show-flow')
  if (!raw) return null
  try {
    return JSON.parse(raw) as { kind: 'page' | 'step'; role?: 'main' | 'secondary'; pageId?: string; index?: number }
  }
  catch {
    return null
  }
}

const onDropStep = (stepIndex: number, e: DragEvent) => {
  const data = readTransfer(e)
  if (!data) return
  if (data.kind === 'page' && data.role && data.pageId) {
    showFlowStore.addPageToStep(data.role, data.pageId, stepIndex)
  }
  else if (data.kind === 'step' && data.index !== undefined) {
    showFlowStore.moveStep(data.index, stepIndex)
  }
}

const onDropGap = (atIndex: number, e: DragEvent) => {
  const data = readTransfer(e)
  if (!data) return
  if (data.kind === 'page' && data.role && data.pageId) {
    showFlowStore.insertStepAt(data.role, data.pageId, atIndex)
  }
  else if (data.kind === 'step' && data.index !== undefined) {
    showFlowStore.moveStep(data.index, atIndex > data.index ? atIndex - 1 : atIndex)
  }
}

const updateFlowMeta = (patch: Partial<{ name: string; confirmationEnabled: boolean; confirmationMode: 'strict' | 'loose' }>) => {
  Object.assign(flow.value, patch)
  showFlowStore.save()
}

const renameStep = (stepId: string, label: string) => showFlowStore.renameStep(stepId, label)

const dismissReport = () => { lastReport.value = null }

const { enterScreening } = useScreening()
const enterScreeningWithFlow = () => enterScreening()

const openSecondaryScreen = () => {
  window.open((secondarySource.value?.mdPath || '/reveal/slides.md').replace(/\/[^/]*\.md$/, '/') || '/reveal/', '_blank')
}

onMounted(() => {
  showFlowStore.init()
  showFlowStore.refreshMainManifest()
})
</script>

<style lang="scss" scoped>
.show-flow-editor {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f2f3f7;
  overflow: hidden;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e5e5;

  .left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 1;
    min-width: 0;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .flow-name {
    width: 200px;
  }
  .switch-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .mode-select {
    width: 180px;
  }
  .ws-status {
    font-size: 12px;
    color: #999;
    &.online { color: #19b26b; }
  }
}

.secondary-config {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e5e5;
  font-size: 13px;

  .md-path {
    width: 360px;
  }
  .meta { color: #999; }
  .error { color: #d25f5f; }
}

.columns {
  flex: 1;
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  min-height: 0;
}

.pool {
  width: 24%;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  padding: 10px;

  .pool-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .pool-list {
    flex: 1;
    overflow-y: auto;
  }
  .pool-tip {
    margin-top: 8px;
    font-size: 11px;
    color: #999;
    line-height: 1.5;
  }
}

.pool-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: grab;
  font-size: 13px;
  background: #fff;
  transition: background .2s;

  &:hover { background: #f5f7ff; }
  &.used {
    background: #f6f6f6;
    .page-title { color: #aaa; }
  }

  .page-index {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    background: #eceffc;
    color: #5b9bd5;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .page-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .page-badge {
    flex-shrink: 0;
    font-size: 11px;
    color: #19b26b;
  }
}

.sequence {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  padding: 10px;

  .seq-title {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 8px;
  }
  .seq-list {
    flex: 1;
    overflow-y: auto;
    position: relative;
  }
}

.gap {
  height: 8px;
  border-radius: 4px;
  transition: background .15s;

  &:hover { background: #dfe6ff; }
  &.last { height: 20px; }
}

.step-card {
  border: 1px solid #e0e0e0;
  border-left: 4px solid #bbb;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 2px;
  cursor: grab;
  background: #fff;
  transition: box-shadow .2s;

  &:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, .08); }
  &.current { border-color: #5b9bd5; box-shadow: 0 0 0 2px rgba(91, 155, 213, .25); }
  &.main-only { border-left-color: #5b9bd5; }
  &.secondary-only { border-left-color: #f0a04b; }
  &.sync { border-left-color: #19b26b; }
  &.event { border-left-color: #9c6cd4; }

  .step-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .step-no {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 700;
    color: #666;
  }
  .step-label {
    flex: 1;
    min-width: 0;
    border: none;
    border-bottom: 1px dashed transparent;
    font-size: 13px;
    padding: 2px 0;
    outline: none;
    background: transparent;

    &:focus { border-bottom-color: #5b9bd5; }
  }
  .kind-tag {
    flex-shrink: 0;
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 3px;
    background: #f0f1f5;
    color: #888;
  }

  .step-targets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .target {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 4px;
    background: #f7f7f7;
    color: #aaa;

    &.active {
      background: #eef4ff;
      color: #333;
    }
    .role {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 3px;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #e2e2e2;
      color: #fff;
    }
    &.main.active .role { background: #5b9bd5; }
    &.secondary.active .role { background: #f0a04b; }
    .title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .clear {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #bbb;
      cursor: pointer;
      font-size: 13px;

      &:hover { color: #d25f5f; }
    }
  }

  .step-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;

    button {
      border: 1px solid #e0e0e0;
      background: #fff;
      border-radius: 4px;
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
      color: #888;

      &:hover { border-color: #5b9bd5; color: #5b9bd5; }
      &.danger:hover { border-color: #d25f5f; color: #d25f5f; }
    }
  }
}

.empty {
  padding: 40px 0;
  text-align: center;
  color: #bbb;
  font-size: 13px;
}

.report {
  position: relative;
  padding: 8px 40px 8px 16px;
  background: #fffbe6;
  border-top: 1px solid #f0e0a0;
  font-size: 12px;
  color: #8c7a2f;

  .dismiss {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    background: transparent;
    cursor: pointer;
    color: #999;
    font-size: 14px;
  }
}
</style>
