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
  /** 多方案：全部已保存方案；flow 为当前激活方案（计算属性，编辑即写入对应方案） */
  const flowList = ref<ShowFlow[]>(persisted.flows?.length ? persisted.flows : [persisted.flow])
  const activeFlowId = ref<string>(persisted.activeFlowId || flowList.value[0].id)
  const flow = computed<ShowFlow>(() => flowList.value.find(f => f.id === activeFlowId.value) ?? flowList.value[0])
  /** 未编排池跟随方案保存（多方案互不干扰） */
  const poolOf = (role: 'main' | 'secondary'): string[] => {
    const f = flow.value as ShowFlow
    if (!f.unmappedPool) f.unmappedPool = {}
    if (!Array.isArray(f.unmappedPool[role])) f.unmappedPool[role] = []
    return f.unmappedPool[role]
  }

  const mainSource = computed(() => sources.value.find(s => s.role === 'main'))
  const secondarySource = computed(() => sources.value.find(s => s.role === 'secondary'))

  const save = () => {
    saveShowFlowState({
      version: 2,
      sources: sources.value,
      flow: flow.value,
      flows: flowList.value,
      activeFlowId: activeFlowId.value,
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
  /** controller 角色被其他存活窗口占用（区别于服务端不可达） */
  const roleTaken = ref(false)
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
    const result = reconcileSteps(manifest, flow.value.steps, poolOf(poolKey as 'main' | 'secondary'), sourceLabel)
    flow.value.steps = result.steps
    poolOf(poolKey as 'main' | 'secondary').splice(0, poolOf(poolKey as 'main' | 'secondary').length, ...result.unmapped)
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

  // ---------- 方案管理（多方案保存/切换） ----------
  const schemeOptions = computed(() =>
    flowList.value.map((f, i) => ({ label: `${i + 1}. ${f.name}（${f.steps.length} 步）`, value: f.id })),
  )

  /** 切换方案：停止当前放映会话，编辑目标指向新方案（未编排池跟随方案） */
  const switchScheme = (id: string) => {
    if (id === activeFlowId.value || !flowList.value.some(f => f.id === id)) return
    activeFlowId.value = id
    controller?.stop()
    save()
    message.success(`已切换到方案「${flow.value.name}」`, { duration: 2000 })
  }

  /** 另存为新方案：深拷贝当前方案（含步骤），重命名后追加并切换过去 */
  const saveAsNewScheme = (name?: string) => {
    const copy: ShowFlow = JSON.parse(JSON.stringify(flow.value))
    copy.id = `flow-${Math.random().toString(36).slice(2, 10)}`
    copy.name = (name || '').trim() || `${flow.value.name} 副本`
    copy.enabled = false
    copy.currentStepId = undefined
    flowList.value.push(copy)
    activeFlowId.value = copy.id
    controller?.stop()
    save()
    message.success(`已保存为新方案「${copy.name}」`, { duration: 2000 })
  }

  /** 删除当前方案（至少保留一个；仅有一个时清空步骤而非删除） */
  const deleteScheme = () => {
    if (flowList.value.length <= 1) {
      flow.value.steps = []
      flow.value.currentStepId = undefined
      controller?.stop()
      save()
      message.info('最后一个方案不可删除，已清空其步骤', { duration: 2500 })
      return
    }
    const name = flow.value.name
    const idx = flowList.value.findIndex(f => f.id === activeFlowId.value)
    flowList.value.splice(idx, 1)
    activeFlowId.value = flowList.value[Math.max(0, idx - 1)].id
    controller?.stop()
    save()
    message.success(`已删除方案「${name}」`, { duration: 2000 })
  }

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
        if (msg.type === 'HELLO_ACK') {
          wsConnected.value = true
          roleTaken.value = false
        }
        if (msg.type === 'ERROR' && msg.code === 'ROLE_TAKEN') {
          // 本页被拒绝为 controller：另一窗口的控制台仍在线（可点「接管控制台」强制夺取）
          roleTaken.value = true
          if (!roleTakenNotified) {
            roleTakenNotified = true
            message.warning('已有控制台在其他窗口运行，可点「接管控制台」夺取', { duration: 3000 })
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

  /** 强制接管 controller 角色（服务端会替换占用中的旧控制台） */
  const takeoverController = () => {
    roleTaken.value = false
    wsClient?.takeover()
    message.info('正在接管控制台 ...', { duration: 1500 })
  }

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
    const pool = [...poolOf(role)]
    poolOf(role).splice(0, poolOf(role).length, ...pool.filter(id => id !== pageId))
    if (stepIndex !== undefined && flow.value.steps[stepIndex]) {
      const step = flow.value.steps[stepIndex]
      const oldPageId = role === 'main' ? step.main?.pageId : step.secondary?.pageId
      // 替换引用时旧页面回到未编排池
      if (oldPageId && oldPageId !== pageId) {
        poolOf(role).push(oldPageId)
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
    const pool = [...poolOf(role)]
    poolOf(role).splice(0, poolOf(role).length, ...pool.filter(id => id !== pageId))
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
      poolOf(role).push(pageId)
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
      if (pageId) poolOf(role).push(pageId)
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
    flowList,
    activeFlowId,
    schemeOptions,
    switchScheme,
    saveAsNewScheme,
    deleteScheme,
    roleTaken,
    takeoverController,
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
