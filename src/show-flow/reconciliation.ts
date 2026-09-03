/**
 * 源页面变更对账（reconciliation）。
 *
 * 输入：某内容源的新 PageManifest 集合 + 现有 ShowFlow steps + 未编排池。
 * 输出：报告 + 修订后的 steps / 未编排池。
 *
 * 规则：
 * - 页面内容修改（同 id）：只刷新标题/缩略图等展示信息，Step 不变（Step 本身只存 pageId，无需改动）
 * - 页面重排：pageId 不变，天然无影响
 * - 页面删除：所有引用该 pageId 的 ScreenTarget 清空为 keep；
 *   若某 Step 因此既不 goto 主屏、不 goto 副屏、也无 tablet/mqtt/ws 事件，则整步删除并给出提示
 * - 新增页面：进入未编排池，不自动加入序列
 */
import type { PageManifest, ReconciliationReport, ShowStep, ScreenTarget } from './types'

function emptyReport(): ReconciliationReport {
  return { kept: 0, updated: 0, added: 0, removed: 0, removedNodeRefs: 0, removedSteps: [], messages: [] }
}

function stepHasAnyAction(step: ShowStep): boolean {
  return !!(
    step.main?.action === 'goto' ||
    step.secondary?.action === 'goto' ||
    step.tablet?.scene ||
    step.mqtt?.topic ||
    step.websocket?.event
  )
}

function pruneTargets(step: ShowStep, aliveIds: Set<string>, role: 'main' | 'secondary', report: ReconciliationReport) {
  const target: ScreenTarget | undefined = role === 'main' ? step.main : step.secondary
  if (target?.action !== 'goto' || !target.pageId) return
  if (!aliveIds.has(target.pageId)) {
    const cleared: ScreenTarget = { action: 'keep' }
    if (role === 'main') step.main = cleared
    else step.secondary = cleared
    report.removedNodeRefs++
    report.messages.push(`${role === 'main' ? '主屏' : '副屏'}页面引用（${target.pageId}）已因源页面删除被同步移除`)
  }
}

export function reconcileSteps(
  newManifest: PageManifest[],
  steps: ShowStep[],
  unmapped: string[],
  sourceLabel: string,
  role: 'main' | 'secondary' | 'both' = 'both',
): { steps: ShowStep[]; unmapped: string[]; report: ReconciliationReport } {
  const report = emptyReport()
  const aliveIds = new Set(newManifest.map(p => p.id))

  // 1. 清理失效引用
  const prunedSteps = steps.map(step => {
    const copy: ShowStep = JSON.parse(JSON.stringify(step))
    if (role === 'main' || role === 'both') pruneTargets(copy, aliveIds, 'main', report)
    if (role === 'secondary' || role === 'both') pruneTargets(copy, aliveIds, 'secondary', report)
    return copy
  })

  // 2. 删除空 Step
  const keptSteps: ShowStep[] = []
  for (const step of prunedSteps) {
    if (stepHasAnyAction(step)) keptSteps.push(step)
    else {
      report.removedSteps.push(step.label || step.id)
      report.messages.push(`虚拟步骤「${step.label || step.id}」已无任何操作，已自动移除`)
    }
  }
  // 重新编号
  keptSteps.forEach((step, i) => { step.order = i + 1 })

  // 3. 未编排池：移除已不存在的 id，加入新 id
  const unmappedKept = unmapped.filter(id => aliveIds.has(id))
  const referenced = new Set<string>()
  for (const step of keptSteps) {
    if (step.main?.pageId) referenced.add(step.main.pageId)
    if (step.secondary?.pageId) referenced.add(step.secondary.pageId)
  }
  for (const page of newManifest) {
    if (referenced.has(page.id)) continue
    if (unmappedKept.includes(page.id)) { report.kept++; continue }
    unmappedKept.push(page.id)
    report.added++
  }
  report.removed = unmapped.length - unmappedKept.length

  if (report.added) report.messages.push(`${sourceLabel} 新增 ${report.added} 页，已放入未编排页面池`)
  if (report.removedNodeRefs) {
    report.messages.push(`已移除 ${report.removedNodeRefs} 个虚拟节点引用，请留意同步提示`)
  }
  return { steps: keptSteps, unmapped: unmappedKept, report }
}
