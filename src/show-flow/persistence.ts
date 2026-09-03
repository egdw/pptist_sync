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
    mdPath: '/reveal/slides.md',
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

export function loadShowFlowState(): ShowFlowPersistence {
  const fallback: ShowFlowPersistence = {
    version: 1,
    sources: defaultSources(),
    flow: createDefaultFlow(),
  }
  try {
    const raw = localStorage.getItem(SHOW_FLOW_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as ShowFlowPersistence
    if (!parsed?.flow || !Array.isArray(parsed.flow.steps)) return fallback
    // 简单迁移兜底：缺失字段用默认值补齐
    return {
      version: 1,
      sources: parsed.sources?.length ? parsed.sources : defaultSources(),
      flow: { ...createDefaultFlow(), ...parsed.flow },
      unmappedPool: parsed.unmappedPool || {},
    }
  }
  catch {
    return fallback
  }
}

export function saveShowFlowState(state: ShowFlowPersistence): void {
  localStorage.setItem(SHOW_FLOW_STORAGE_KEY, JSON.stringify(state))
}
