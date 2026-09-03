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
    enabled: false,
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

export async function loadShowFlowStateFromServer(): Promise<ShowFlowPersistence | null> {
  const response = await fetch('/showflow-api/state', { cache: 'no-store' })
  if (!response.ok) throw new Error(`读取服务端方案失败（${response.status}）`)
  const data = await response.json()
  return data?.exists && data?.state ? data.state as ShowFlowPersistence : null
}

export async function saveShowFlowStateToServer(state: ShowFlowPersistence): Promise<void> {
  const response = await fetch('/showflow-api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
  if (!response.ok) throw new Error(`保存服务端方案失败（${response.status}）`)
}
