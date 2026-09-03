/**
 * ShowFlow 全局状态（Pinia）。
 *
 * - 持久化：localStorage（flow/sources/未编排池），刷新不丢
 * - Manifest 缓存：主屏来自 slidesStore（实时），副屏来自 Reveal MD 拉取
 * - Reconciliation：主屏 slides 的 id 集合变化时自动对账
 * - Controller / WsClient 单例
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useSlidesStore } from '@/store'
import message from '@/utils/message'
import { PptistScreenAdapter } from './adapters/pptist'
import { PptistRemoteScreenAdapter } from './adapters/pptistRemote'
import { RevealMarkdownScreenAdapter, type ShowFlowTransport } from './adapters/reveal'
import { ShowFlowController } from './controller'
import { buildPptistManifest } from './manifest'
import { reconcileSteps } from './reconciliation'
import { loadShowFlowState, saveShowFlowState } from './persistence'
import { ShowFlowWsClient, resolveShowFlowWsUrl } from './websocket/client'
import type {
  ContentSource,
  OnlineStatus,
  PageManifest,
  ReconciliationReport,
  ShowFlow,
  ShowFlowPhase,
  ShowStep,
  StepTargetSnapshot,
} from './types'

export const useShowFlowStore = defineStore('showFlow', () => {
  const slidesStore = useSlidesStore()

  // ---------- 持久化状态 ----------
  const persisted = loadShowFlowState()
  const sources = ref<ContentSource[]>(persisted.sources)
  const flow = ref<ShowFlow>(persisted.flow)
  const unmappedPool = ref<Record<string, string[]>>(persisted.unmappedPool || {})

  const mainSource = computed(() => sources.value.find(s => s.role === 'main'))
  const secondarySource = computed(() => sources.value.find(s => s.role === 'secondary'))

  const save = () => {
    saveShowFlowState({
      version: 1,
      sources: sources.value,
      flow: flow.value,
      unmappedPool: unmappedPool.value,
    })
  }

  // ---------- Manifest ----------
  const mainManifest = ref<PageManifest[]>([])
  const secondaryManifest = ref<PageManifest[]>([])
  const secondaryManifestError = ref('')
  /** 副屏为 PPTist 文稿时的原始 slides（编排页渲染缩略图用） */
  const secondarySlides = ref<import('@/types/slides').Slide[]>([])

  const getStep = (i: number): ShowStep | undefined => flow.value.steps[i]

  // ---------- Transport / WS ----------
  const transport: ShowFlowTransport = {
    sendToRole(role, payload) {
      wsClient?.send({ ...payload, role } as never)
    },
  }

  let wsClient: ShowFlowWsClient | null = null
  let controller: ShowFlowController | null = null

  // ---------- Controller 镜像（响应式） ----------
  const phase = ref<ShowFlowPhase>('READY')
  const snapshot = ref<StepTargetSnapshot | null>(null)
  const currentStepIndex = ref(-1)
  const online = ref<OnlineStatus>({ main: false, secondary: false, mqtt: false, tablets: [false, false, false, false] })
  const wsConnected = ref(false)
  const lastReport = ref<ReconciliationReport | null>(null)

  const createController = () => {
    const c = new ShowFlowController(
      () => ({
        main: mainAdapter!,
        secondary: secondaryAdapter,
      }),
      transport,
      {
        onPhaseChange: p => { phase.value = p },
        onStepChange: snap => {
          snapshot.value = snap
          currentStepIndex.value = controller?.currentStepIndex ?? -1
          flow.value.currentStepId = snap?.stepId
          save()
        },
        onNotice: (text, type) => {
          if (type === 'error') message.error(text, { duration: 3000 })
          else if (type === 'warning') message.warning(text, { duration: 3000 })
          else if (type === 'success') message.success(text, { duration: 1500 })
          else message.info(text, { duration: 2000 })
        },
        onEventAction: (stepId, timing) => {
          // 阶段 4 接入 MQTT / 平板 scene；当前仅记录
          console.info(`[ShowFlow] step ${stepId} event action (${timing})`)
        },
      },
      () => ({
        enabled: flow.value.enabled,
        confirmationEnabled: flow.value.confirmationEnabled,
        confirmationMode: flow.value.confirmationMode,
        stepCount: flow.value.steps.length,
      }),
    )
    c.registerStepsAccessor(getStep)
    return c
  }

  // ---------- Adapters ----------
  let mainAdapter: PptistScreenAdapter | null = null
  let secondaryAdapter: RevealMarkdownScreenAdapter | PptistRemoteScreenAdapter | null = null

  const buildSecondaryAdapter = () => {
    const src = secondarySource.value
    if (src?.kind === 'reveal-md' && src.mdPath) {
      secondaryAdapter = new RevealMarkdownScreenAdapter(src.mdPath, transport)
    }
    else if (src?.kind === 'pptist-remote') {
      secondaryAdapter = new PptistRemoteScreenAdapter(transport)
    }
    else {
      secondaryAdapter = null
    }
  }

  const refreshSecondaryManifest = async () => {
    const src = secondarySource.value
    if (!src || src.kind === 'pptist' /* 主屏本机文档不能作为副屏 */) {
      secondaryManifest.value = []
      secondarySlides.value = []
      secondaryManifestError.value = ''
      return
    }
    try {
      buildSecondaryAdapter()
      if (!secondaryAdapter) {
        secondaryManifest.value = []
        secondarySlides.value = []
        secondaryManifestError.value = src.kind === 'reveal-md' ? '未配置 Markdown 路径' : '副屏来源不可用'
        return
      }
      secondaryManifest.value = await secondaryAdapter.getManifest()
      secondarySlides.value = secondaryAdapter instanceof PptistRemoteScreenAdapter ? secondaryAdapter.getSlides() : []
      secondaryManifestError.value = ''
    }
    catch (err) {
      secondaryManifest.value = []
      secondarySlides.value = []
      secondaryManifestError.value = (err as Error).message
    }
  }

  const refreshMainManifest = () => {
    mainManifest.value = buildPptistManifest(slidesStore.slides)
  }

  // ---------- Reconciliation ----------
  const reconcile = (role: 'main' | 'secondary') => {
    const manifest = role === 'main' ? mainManifest.value : secondaryManifest.value
    if (!manifest.length && role === 'secondary') return
    const sourceLabel = role === 'main' ? '主屏' : '副屏'
    const poolKey = role
    const result = reconcileSteps(manifest, flow.value.steps, unmappedPool.value[poolKey] || [], sourceLabel)
    flow.value.steps = result.steps
    unmappedPool.value[poolKey] = result.unmapped
    lastReport.value = result.report
    if (result.report.messages.length || result.report.added || result.report.removedNodeRefs) {
      message.info(`${sourceLabel}源同步完成：保留 ${result.report.kept} · 新增 ${result.report.added} · 移除引用 ${result.report.removedNodeRefs}`, { duration: 3000 })
    }
    save()
  }

  // 主屏 slides id 集合变化（增删/导入/替换文稿）时自动对账
  const slideIdsKey = computed(() => slidesStore.slides.map(s => s.id).join(','))
  watch(slideIdsKey, () => {
    if (!initialized) return
    const oldManifest = mainManifest.value
    refreshMainManifest()
    const changed = oldManifest.length !== mainManifest.value.length ||
      oldManifest.some((p, i) => p.id !== mainManifest.value[i]?.id)
    if (changed) reconcile('main')
  })
  // 页面内容修改：仅刷新展示信息（标题），不动 Steps
  watch(() => slidesStore.slides, refreshMainManifest, { deep: false })

  // ---------- 联动开关 ----------
  const initialized = { value: false }

  /** 多屏联动总开关：关闭时立即停止 Controller，放映恢复普通模式 */
  const setEnabled = (v: boolean) => {
    flow.value.enabled = v
    if (!v) controller?.stop()
    save()
  }

  const init = () => {
    if (initialized.value) return
    initialized.value = true
    mainAdapter = new PptistScreenAdapter()
    refreshMainManifest()
    refreshSecondaryManifest()
    reconcile('main')
    reconcile('secondary')

    controller = createController()
    let roleTakenNotified = false
    wsClient = new ShowFlowWsClient(resolveShowFlowWsUrl(), {
      onMessage: msg => {
        if (msg.type === 'HELLO_ACK') wsConnected.value = true
        if (msg.type === 'ERROR' && msg.code === 'ROLE_TAKEN') {
          // 本页被拒绝为 controller：另一窗口的控制台仍在线（僵尸连接会被服务端探测后接管）
          if (!roleTakenNotified) {
            roleTakenNotified = true
            message.warning('已有控制台在其他窗口运行，本页暂不取得控制权', { duration: 3000 })
          }
          return
        }
        controller?.handleWsMessage(msg)
      },
      onDisconnect: () => {
        wsConnected.value = false
        online.value = { ...online.value, secondary: false }
      },
    })
    wsClient.connect()

    // 心跳轮询在线状态
    window.setInterval(() => {
      if (!wsClient) return
      online.value = {
        ...online.value,
        main: true,
        secondary: flow.value.enabled ? wsClient.isRoleOnline('secondary') : online.value.secondary,
      }
    }, 3000)
  }

  // ---------- 放映接管入口 ----------
  const controllerReady = computed(() => flow.value.enabled)

  const startShow = async () => {
    if (!controller) controller = createController()
    if (flow.value.steps.length) await controller.start(0)
  }

  const stopShow = () => controller?.stop()

  const next = () => controller?.next()
  const previous = () => controller?.previous()
  const gotoStep = (i: number) => controller?.gotoStep(i)

  // ---- 手动兜底（异常情况下使用） ----
  const resendCurrentStep = () => controller?.resendCurrent()
  const resyncAllScreens = () => controller?.resyncAll()
  const forceCompleteStep = () => controller?.forceComplete()
  const skipSecondaryScreen = () => controller?.skipSecondary()

  // ---------- Step 编辑操作 ----------
  const makeTarget = (role: 'main' | 'secondary', pageId: string) => ({
    action: 'goto' as const,
    pageId,
  })

  const appendStep = (partial: Partial<ShowStep> = {}) => {
    const step: ShowStep = {
      id: `step-${Math.random().toString(36).slice(2, 10)}`,
      order: flow.value.steps.length + 1,
      ...partial,
    }
    flow.value.steps.push(step)
    save()
    return step
  }

  const addPageToStep = (role: 'main' | 'secondary', pageId: string, stepIndex?: number) => {
    const target = makeTarget(role, pageId)
    // 从未编排池移除
    const pool = unmappedPool.value[role] || []
    unmappedPool.value[role] = pool.filter(id => id !== pageId)
    if (stepIndex !== undefined && flow.value.steps[stepIndex]) {
      const step = flow.value.steps[stepIndex]
      const oldPageId = role === 'main' ? step.main?.pageId : step.secondary?.pageId
      // 替换引用时旧页面回到未编排池
      if (oldPageId && oldPageId !== pageId) {
        unmappedPool.value[role] = [...(unmappedPool.value[role] || []), oldPageId]
      }
      if (role === 'main') step.main = target
      else step.secondary = target
    }
    else {
      appendStep(role === 'main' ? { main: target } : { secondary: target })
    }
    save()
  }

  /** 在指定位置插入一个新 Step（拖拽到两个 Step 之间的落点） */
  const insertStepAt = (role: 'main' | 'secondary', pageId: string, atIndex: number) => {
    const target = makeTarget(role, pageId)
    const pool = unmappedPool.value[role] || []
    unmappedPool.value[role] = pool.filter(id => id !== pageId)
    const step: ShowStep = {
      id: `step-${Math.random().toString(36).slice(2, 10)}`,
      order: 0,
      ...(role === 'main' ? { main: target } : { secondary: target }),
    }
    const idx = Math.max(0, Math.min(atIndex, flow.value.steps.length))
    flow.value.steps.splice(idx, 0, step)
    flow.value.steps.forEach((s, i) => { s.order = i + 1 })
    save()
  }

  const removePageFromStep = (role: 'main' | 'secondary', stepId: string) => {
    const step = flow.value.steps.find(s => s.id === stepId)
    if (!step) return
    const pageId = role === 'main' ? step.main?.pageId : step.secondary?.pageId
    if (role === 'main') step.main = { action: 'keep' }
    else step.secondary = { action: 'keep' }
    if (pageId) {
      unmappedPool.value[role] = [...(unmappedPool.value[role] || []), pageId]
    }
    normalizeSteps()
    save()
  }

  /** Step 失去全部操作后自动删除（编辑期手动清空的场景） */
  const normalizeSteps = () => {
    flow.value.steps = flow.value.steps.filter(step =>
      step.main?.action === 'goto' ||
      step.secondary?.action === 'goto' ||
      step.tablet?.scene ||
      step.mqtt?.topic ||
      step.websocket?.event,
    )
    flow.value.steps.forEach((step, i) => { step.order = i + 1 })
  }

  const removeStep = (stepId: string) => {
    const idx = flow.value.steps.findIndex(s => s.id === stepId)
    if (idx === -1) return
    const step = flow.value.steps[idx]
    // 被移除 Step 引用的页面回到未编排池
    for (const role of ['main', 'secondary'] as const) {
      const pageId = role === 'main' ? step.main?.pageId : step.secondary?.pageId
      if (pageId) unmappedPool.value[role] = [...(unmappedPool.value[role] || []), pageId]
    }
    flow.value.steps.splice(idx, 1)
    flow.value.steps.forEach((s, i) => { s.order = i + 1 })
    save()
  }

  const duplicateStep = (stepId: string) => {
    const idx = flow.value.steps.findIndex(s => s.id === stepId)
    if (idx === -1) return
    const copy: ShowStep = JSON.parse(JSON.stringify(flow.value.steps[idx]))
    copy.id = `step-${Math.random().toString(36).slice(2, 10)}`
    copy.label = copy.label ? `${copy.label} (副本)` : undefined
    flow.value.steps.splice(idx + 1, 0, copy)
    flow.value.steps.forEach((s, i) => { s.order = i + 1 })
    save()
  }

  const moveStep = (from: number, to: number) => {
    const steps = flow.value.steps
    if (from < 0 || from >= steps.length || to < 0 || to >= steps.length) return
    const [step] = steps.splice(from, 1)
    steps.splice(to, 0, step)
    steps.forEach((s, i) => { s.order = i + 1 })
    save()
  }

  const renameStep = (stepId: string, label: string) => {
    const step = flow.value.steps.find(s => s.id === stepId)
    if (!step) return
    step.label = label.trim() || undefined
    save()
  }

  const updateSecondarySource = (patch: Partial<ContentSource>) => {
    const idx = sources.value.findIndex(s => s.role === 'secondary')
    if (idx === -1) return
    sources.value[idx] = { ...sources.value[idx], ...patch }
    secondaryManifest.value = []
    save()
    refreshSecondaryManifest()
    reconcile('secondary')
  }

  /**
   * 本机被远程控制器接管（PPTist 副屏页 /secondary 使用）：
   * 为 true 时抑制本机翻页，ShowFlow 是唯一时间轴；WS 断开时复位恢复本机控制。
   * 属于单标签页状态，不持久化。
   */
  const remoteControlled = ref(false)
  const setRemoteControlled = (v: boolean) => { remoteControlled.value = v }

  return {
    sources,
    flow,
    unmappedPool,
    mainSource,
    secondarySource,
    mainManifest,
    secondaryManifest,
    secondaryManifestError,
    secondarySlides,
    phase,
    snapshot,
    currentStepIndex,
    online,
    wsConnected,
    lastReport,
    controllerReady,
    init,
    setEnabled,
    save,
    refreshMainManifest,
    refreshSecondaryManifest,
    reconcile,
    startShow,
    stopShow,
    next,
    previous,
    gotoStep,
    resendCurrentStep,
    resyncAllScreens,
    forceCompleteStep,
    skipSecondaryScreen,
    appendStep,
    addPageToStep,
    insertStepAt,
    removePageFromStep,
    removeStep,
    duplicateStep,
    moveStep,
    renameStep,
    updateSecondarySource,
    remoteControlled,
    setRemoteControlled,
    getStep,
  }
})
