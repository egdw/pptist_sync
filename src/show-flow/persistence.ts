/**
 * ShowFlow 持久化（localStorage）。
 * 刷新浏览器后编排结果不丢失；源页面引用全部为 pageId，源文件重载后由
 * reconciliation 自动重建关系。
 */
import { nanoid } from 'nanoid'
import type { ContentSource, ShowFlow, ShowFlowPersistence } from './types'

export const SHOW_FLOW_STORAGE_KEY = 'PPTIST_SHOW_FLOW'

export function defaultSecondarySource(): ContentSource {
  return {
    id: 'secondary-reveal',
    kind: 'reveal-md',
    name: '副屏 Reveal / Markdown',
    role: 'secondary',
    // Studio「发布」后的正式内容（从未编辑时自动播种原始样例）；与 Studio 页面内容编辑同源
    mdPath: '/api/studio/slides/active/raw',
  }
}

export function createDefaultFlow(): ShowFlow {
  return {
    id: `flow-${nanoid(8)}`,
    name: '未命名联动流程',
    // 多屏联动默认启用：打开编排页/放映即联动模式，无需手动打开开关
    enabled: true,
    confirmationEnabled: true,
    confirmationMode: 'strict',
    mainSourceId: 'main-pptist',
    steps: [],
  }
}

export function defaultSources(): ContentSource[] {
  return [
    { id: 'main-pptist', kind: 'pptist', name: '主屏 PPTist（当前文稿）', role: 'main' },
    defaultSecondarySource(),
  ]
}

/** 跨版本迁移（本地缓存与服务端方案共用）：单方案→多方案、未编排池随方案、mdPath 默认值升级、补齐缺失角色源 */
export function migrateShowFlowState(parsed: ShowFlowPersistence): ShowFlowPersistence {
  const flows = Array.isArray(parsed.flows) && parsed.flows.length ? parsed.flows : [parsed.flow]
  const activeFlowId = parsed.activeFlowId && flows.some(f => f.id === parsed.activeFlowId)
    ? parsed.activeFlowId
    : flows[0].id
  // 旧版全局未编排池迁移到当前方案内
  const activeFlow = flows.find(f => f.id === activeFlowId)
  if (parsed.unmappedPool && activeFlow && !activeFlow.unmappedPool) {
    activeFlow.unmappedPool = parsed.unmappedPool
  }
  // v3：reveal 副屏默认源从静态样例文件切到 Studio 发布内容（老用户自定义的其他路径不动）
  for (const source of parsed.sources || []) {
    if (source.kind === 'reveal-md' && source.mdPath === '/reveal/slides.md') {
      source.mdPath = defaultSecondarySource().mdPath
    }
  }
  // 多屏联动默认启用：旧方案里存储的 enabled:false 一律升级为 true（联动即默认工作模式）
  for (const flow of flows) flow.enabled = true
  // 旧版缓存可能缺 main/secondary 源（缺 secondary 会导致副屏池永远为空）
  const sources = parsed.sources?.length ? [...parsed.sources] : defaultSources()
  if (!sources.some(s => s.role === 'main')) {
    sources.unshift({ id: 'main-pptist', kind: 'pptist', name: '主屏 PPTist（当前文稿）', role: 'main' })
  }
  if (!sources.some(s => s.role === 'secondary')) {
    sources.push(defaultSecondarySource())
  }
  return {
    version: 3,
    serverRevision: parsed.serverRevision,
    sources,
    flow: { ...createDefaultFlow(), ...parsed.flow },
    flows: flows.map(f => ({ ...createDefaultFlow(), ...f })),
    activeFlowId,
    unmappedPool: parsed.unmappedPool || {},
  }
}

export function loadShowFlowState(): ShowFlowPersistence {
  const fallback: ShowFlowPersistence = {
    version: 3,
    sources: defaultSources(),
    flow: createDefaultFlow(),
    flows: [],
    activeFlowId: undefined,
  }
  try {
    const raw = localStorage.getItem(SHOW_FLOW_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as ShowFlowPersistence
    if (!parsed?.flow || !Array.isArray(parsed.flow.steps)) return fallback
    return migrateShowFlowState(parsed)
  }
  catch {
    return fallback
  }
}

export function saveShowFlowState(state: ShowFlowPersistence): void {
  localStorage.setItem(SHOW_FLOW_STORAGE_KEY, JSON.stringify(state))
}

/**
 * 放映进度属于单个控制台的运行态，不能写入共享方案。
 * 否则每次空格翻页都会递增服务端 revision，并让其他已打开窗口立即变成旧版本。
 */
export function stripShowFlowRuntimeState(flow: ShowFlow): ShowFlow {
  const persistable = { ...flow }
  delete persistable.currentStepId
  return persistable
}

export async function loadShowFlowStateFromServer(): Promise<ShowFlowPersistence | null> {
  const response = await fetch('/showflow-api/state', { cache: 'no-store' })
  if (!response.ok) throw new Error(`读取服务端方案失败（${response.status}）`)
  const data = await response.json()
  return data?.exists && data?.state ? data.state as ShowFlowPersistence : null
}

export async function saveShowFlowStateToServer(state: ShowFlowPersistence): Promise<number> {
  const response = await fetch('/showflow-api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, baseRevision: state.serverRevision || 0 }),
    keepalive: true,
  })
  if (response.status === 409) throw new Error('方案已在其他窗口或电脑更新，请刷新页面后再编辑')
  if (!response.ok) throw new Error(`保存服务端方案失败（${response.status}）`)
  const data = await response.json()
  return Number(data.revision || 0)
}
