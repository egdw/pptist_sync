<template>
  <div class="show-flow-editor">
    <header class="header">
      <div class="left">
        <Select
          class="scheme-select"
          :value="activeFlowId"
          :options="schemeOptions"
          @update:value="(v: string | number) => showFlowStore.switchScheme(String(v))"
        />
        <template v-if="saveAsVisible">
          <Input
            class="save-as-input"
            :value="saveAsName"
            @update:value="(v: string) => (saveAsName = v)"
            placeholder="新方案名称"
            @keydown.enter="confirmSaveAs()"
          />
          <Button size="small" type="primary" @click="confirmSaveAs()">保存</Button>
          <Button size="small" @click="closeSaveAs()">取消</Button>
        </template>
        <template v-else>
          <Button size="small" @click="openSaveAs()">另存为</Button>
          <Button size="small" :class="{ 'confirm-arm': deleteArmed }" @click="deleteSchemeClick()">{{ deleteArmed ? '确认删除？' : '删除方案' }}</Button>
        </template>
        <Divider :margin="10" />
        <Input
          class="flow-name"
          :value="flow.name"
          @update:value="(v: string) => updateFlowMeta({ name: v })"
          placeholder="方案名称"
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
        <template v-if="roleTaken">
          <span class="ws-status warn">控制台在其他窗口</span>
          <Button size="small" type="primary" @click="showFlowStore.takeoverController()">接管控制台</Button>
        </template>
        <span v-else-if="!wsConnected" class="ws-status">控制服务未连接</span>
        <span v-else class="ws-status online">控制服务已连接</span>
        <Button size="small" @click="openSecondaryScreen">打开副屏页</Button>
        <Button size="small" @click="refreshSecondary">刷新副屏清单</Button>
        <Button size="small" type="primary" @click="enterScreeningWithFlow">开始联动放映</Button>
      </div>
    </header>

    <div class="secondary-config">
      <span class="label">副屏来源：</span>
      <Select
        class="kind-select"
        :value="secondarySource?.kind || 'reveal-md'"
        :options="[
          { label: 'PPTist 文档（服务端上传）', value: 'pptist-remote' },
          { label: 'Reveal / Markdown', value: 'reveal-md' },
        ]"
        @update:value="v => switchSecondaryKind(v as 'pptist-remote' | 'reveal-md')"
      />
      <template v-if="secondarySource?.kind === 'reveal-md'">
        <Input
          class="md-path"
          :value="secondarySource?.mdPath || ''"
          @update:value="(v: string) => showFlowStore.updateSecondarySource({ mdPath: v })"
          placeholder="Reveal Markdown 路径，如 /reveal/slides.md"
        />
        <span class="meta">副屏页地址：/reveal/</span>
      </template>
      <template v-else>
        <span class="meta">文档来源：服务端「副屏文稿」槽位（/upload 页选择「副屏文稿（PPTist B）」上传），与主屏完全独立；副屏页地址：/secondary</span>
      </template>
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
            class="pool-item card-item"
            :class="{ used: mainUsedIds.has(page.id) }"
            draggable="true"
            @dragstart="onPageDragStart($event, 'main', page.id)"
            @click="showFlowStore.addPageToStep('main', page.id)"
          >
            <div class="pool-thumb">
              <ThumbnailSlide v-if="mainSlideOf(page.index)" :slide="mainSlideOf(page.index)!" :size="124" />
              <div class="thumb-fallback" v-else>{{ page.index }}</div>
            </div>
            <div class="pool-meta">
              <span class="page-index">{{ page.index }}</span>
              <span class="page-title" :title="page.notes">{{ page.title }}</span>
              <span class="page-badge" v-if="mainStepNo(page.id)">Step {{ mainStepNo(page.id) }}</span>
            </div>
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
                  <ThumbnailSlide v-if="mainThumbOf(step)" :slide="mainThumbOf(step)!" :size="36" class="mini-thumb" />
                  <span class="title">{{ mainTargetTitle(step) }}</span>
                  <button v-if="step.main?.action === 'goto'" class="clear" title="清除主屏引用" @click="showFlowStore.removePageFromStep('main', step.id)">×</button>
                </div>
                <div class="target secondary" :class="{ active: step.secondary?.action === 'goto' }">
                  <span class="role">副</span>
                  <ThumbnailSlide v-if="secondaryThumbOf(step)" :slide="secondaryThumbOf(step)!" :size="36" class="mini-thumb" />
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
        <div class="pool-title">副屏页面池（{{ isMdPool ? 'Reveal / Markdown' : 'PPTist B 文稿' }}）</div>
        <div class="pool-list">
          <div
            v-for="page in secondaryManifest"
            :key="page.id"
            class="pool-item card-item"
            :class="{ used: secondaryUsedIds.has(page.id) }"
            draggable="true"
            @dragstart="onPageDragStart($event, 'secondary', page.id)"
            @click="showFlowStore.addPageToStep('secondary', page.id)"
          >
            <template v-if="!isMdPool">
              <div class="pool-thumb">
                <ThumbnailSlide v-if="secondarySlideOf(page.index)" :slide="secondarySlideOf(page.index)!" :size="124" />
                <div class="thumb-fallback" v-else>{{ page.index }}</div>
              </div>
              <div class="pool-meta">
                <span class="page-index">{{ page.index }}</span>
                <span class="page-title">{{ page.title }}</span>
                <span class="page-badge" v-if="secondaryStepNo(page.id)">Step {{ secondaryStepNo(page.id) }}</span>
              </div>
            </template>
            <template v-else>
              <div class="pool-thumb md-thumb">
                <div class="md-h1">{{ page.title }}</div>
                <div class="md-sub" v-if="page.subtitle">{{ page.subtitle }}</div>
              </div>
              <div class="pool-meta">
                <span class="page-index">{{ page.index }}</span>
                <span class="page-title">{{ page.subtitle || page.stage || '（无副标题）' }}</span>
                <span class="page-badge stage-badge" v-if="page.stage">{{ page.stage }}</span>
                <span class="page-badge" v-if="secondaryStepNo(page.id)">Step {{ secondaryStepNo(page.id) }}</span>
              </div>
            </template>
          </div>
          <div v-if="!secondaryManifest.length" class="empty">
            {{ secondaryManifestError || '未加载到副屏页面，请检查上方来源配置' }}
          </div>
        </div>
        <div class="pool-tip">
          {{ isMdPool
            ? '卡片显示各页一级标题与副标题，方便识别；页 id 来自 data-page-id（建议显式标注）'
            : '页 id 为副屏文稿的永久 slideId；在 /upload 重新上传「副屏文稿」后点「刷新副屏清单」自动对账' }}
        </div>
      </section>
    </main>

    <footer class="report" v-if="lastReport">
      源同步结果 —— 保留 {{ lastReport.kept }} · 新增 {{ lastReport.added }} · 引用移除 {{ lastReport.removedNodeRefs }} · 步骤移除 {{ lastReport.removedSteps.length }}
      <button class="dismiss" @click="dismissReport">×</button>
    </footer>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useShowFlowStore } from '@/show-flow/store'
import { useSlidesStore } from '@/store'
import useScreening from '@/hooks/useScreening'
import type { ShowStep } from '@/show-flow/types'
import type { Slide } from '@/types/slides'
import Button from '@/components/Button.vue'
import Input from '@/components/Input.vue'
import Select from '@/components/Select.vue'
import Switch from '@/components/Switch.vue'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'

const showFlowStore = useShowFlowStore()
const slidesStore = useSlidesStore()
const { flow, flowList, activeFlowId, schemeOptions, roleTaken, sources, mainManifest, secondaryManifest, secondaryManifestError, secondarySlides, snapshot, wsConnected, lastReport } = storeToRefs(showFlowStore)
const { slides: mainSlides } = storeToRefs(slidesStore)

/** 另存为新方案（内嵌输入框，避免 prompt 在内嵌浏览器中不可用） */
const saveAsVisible = ref(false)
const saveAsName = ref('')
const openSaveAs = () => {
  saveAsName.value = flow.value.name + ' 副本'
  saveAsVisible.value = true
}
const closeSaveAs = () => { saveAsVisible.value = false }
const confirmSaveAs = () => {
  showFlowStore.saveAsNewScheme(saveAsName.value)
  saveAsVisible.value = false
}

/** 删除方案：两次点击确认（避免 confirm 在内嵌浏览器中不可用） */
const deleteArmed = ref(false)
let deleteArmTimer = 0
const deleteSchemeClick = () => {
  if (!deleteArmed.value) {
    deleteArmed.value = true
    if (deleteArmTimer) clearTimeout(deleteArmTimer)
    deleteArmTimer = window.setTimeout(() => (deleteArmed.value = false), 3000)
    return
  }
  deleteArmed.value = false
  showFlowStore.deleteScheme()
}

// 副屏内容源类型：PPTist 文稿渲染真实缩略图，Reveal/Markdown 渲染 H1 文本卡
const isMdPool = computed(() => secondarySource.value?.kind !== 'pptist-remote')

const mainSlideOf = (index: number): Slide | undefined => mainSlides.value[index - 1]
const secondarySlideOf = (index: number): Slide | undefined => secondarySlides.value[index - 1]
const mainThumbOf = (step: ShowStep): Slide | undefined =>
  step.main?.action === 'goto' ? mainSlideOf(mainManifest.value.find(p => p.id === step.main?.pageId)?.index ?? -1) : undefined
const secondaryThumbOf = (step: ShowStep): Slide | undefined => {
  if (isMdPool.value) return undefined
  if (step.secondary?.action !== 'goto') return undefined
  return secondarySlideOf(secondaryManifest.value.find(p => p.id === step.secondary?.pageId)?.index ?? -1)
}

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
  // 注意：不能带尾斜杠 —— base 为相对路径时 /secondary/ 会导致资源解析到 /secondary/assets/ 404
  const url = secondarySource.value?.kind === 'pptist-remote' ? '/secondary' : '/reveal'
  window.open(url, '_blank')
}

/** 切换副屏内容源类型：kind 切换时清掉旧 mdPath 语义，重新拉清单并对账 */
const switchSecondaryKind = (kind: 'pptist-remote' | 'reveal-md') => {
  if (secondarySource.value?.kind === kind) return
  showFlowStore.updateSecondarySource({
    kind,
    name: kind === 'pptist-remote' ? '副屏 PPTist（服务端上传文稿）' : '副屏 Reveal / Markdown',
  })
}

const refreshSecondary = () => {
  showFlowStore.refreshSecondaryManifest()
  showFlowStore.reconcile('secondary')
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
    white-space: nowrap;
    &.online { color: #19b26b; }
    &.warn { color: #e6a23c; }
  }
  .scheme-select {
    width: 210px;
    flex-shrink: 0;
  }
  .save-as-input {
    width: 160px;
  }
  .confirm-arm {
    border-color: #d25f5f !important;
    color: #d25f5f !important;
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

  .kind-select {
    width: 230px;
  }
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
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  margin-bottom: 10px;
  cursor: grab;
  font-size: 13px;
  background: #fff;
  transition: background .2s, border-color .2s;
  overflow: hidden;

  &:hover { background: #f5f7ff; border-color: #c9d6f5; }
  &.used {
    background: #f6f6f6;
    .page-title { color: #aaa; }
    .pool-thumb { opacity: .45; }
    &.md-thumb { opacity: 1; }
  }

  .pool-thumb {
    display: flex;
    justify-content: center;
    background: #eef0f4;
    padding: 6px;

    :deep(.thumbnail-slide) {
      // ThumbnailSlide 内的 .background 为 absolute 定位，必须建立定位上下文，否则色块逃逸到文档层
      position: relative;
      box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
      flex-shrink: 0;
    }

    &.md-thumb {
      display: block;
      text-align: left;
      min-height: 64px;
      background: linear-gradient(135deg, #f0f4ff 0%, #faf6ff 100%);
    }
  }
  .thumb-fallback {
    width: 124px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #bbb;
    font-size: 20px;
  }
  .md-h1 {
    font-size: 14px;
    font-weight: 700;
    color: #333;
    line-height: 1.45;
    word-break: break-all;
  }
  .md-sub {
    font-size: 11px;
    color: #889;
    margin-top: 5px;
    line-height: 1.5;
    word-break: break-all;
  }

  .pool-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
  }
  .page-index {
    flex-shrink: 0;
    min-width: 20px;
    height: 20px;
    border-radius: 4px;
    background: #eceffc;
    color: #5b9bd5;
    font-size: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
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
  .stage-badge {
    color: #9c6cd4;
    background: #f4eeff;
    border-radius: 3px;
    padding: 0 5px;
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
    .mini-thumb {
      flex-shrink: 0;
      position: relative;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, .08);
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
