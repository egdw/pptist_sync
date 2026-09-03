/**
 * Reconciliation + MD Manifest 解析自测（Node 22+ --experimental-strip-types 直接跑 TS 源）
 * 覆盖验收场景 2/3/4/5/6：
 * - MD 按 --- 分页解析、H1 标题、data-page-id / data-stage / data-tablet-scene
 * - 未标注 data-page-id 时内容稳定 hash
 * - 页面重排/重命名：引用不受影响
 * - 页面删除：引用清除、空步骤删除
 * - 新增页面：进入未编排池
 */
import assert from 'node:assert'
import { parseMarkdownManifest, markdownManifestVersion, stablePageHash } from '../../src/show-flow/manifest.ts'
import { reconcileSteps } from '../../src/show-flow/reconciliation.ts'

let pass = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { console.log('✗ FAIL:', name) } }

// ---------- MD 解析 ----------
const md = `# 首页无元数据

---

<!-- .slide: data-stage="车端联调" data-tablet-scene="vehicle-link" -->
# 方向盘和踏板数据进入行车黑匣子
副标题

---

<!-- .slide: data-page-id="custom-id" data-stage="DMS验证" -->
# DMS在RK3588识别四类驾驶状态

---

<!-- .slide: data-page-id="vehicle-link" data-stage="车端联调" data-tablet-scene="vehicle-link" -->
# 方向盘和踏板数据进入行车黑匣子

---

# 结束页
`

const manifest = parseMarkdownManifest(md)
ok(manifest.length === 5, `按 --- 分页解析出 ${manifest.length} 页（期望 5）`)
ok(manifest[0].title === '首页无元数据', 'H1 提取标题')
ok(manifest[0].id === stablePageHash('# 首页无元数据'), '未标注 data-page-id 时使用内容稳定 hash')
ok(manifest[2].id === 'custom-id', '显式 data-page-id 优先')
ok(manifest[3].id === 'vehicle-link' && manifest[3].stage === '车端联调' && manifest[3].tabletScene === 'vehicle-link', 'data-stage / data-tablet-scene 读取')
ok(markdownManifestVersion(md) !== markdownManifestVersion(md + 'x'), 'manifestVersion 随内容变化')

// ---------- reconciliation ----------
const step = (id, main, secondary, extra = {}) => ({
  id, order: 0, label: id,
  ...(main ? { main: { action: 'goto', pageId: main } } : {}),
  ...(secondary ? { secondary: { action: 'goto', pageId: secondary } } : {}),
  ...extra,
})
const pages = ids => ids.map((id, i) => ({ id, index: i + 1, title: `页${id}` }))

// 场景 4：页面重排 -> 引用不受影响
const m1 = pages(['a', 'b', 'c'])
const steps1 = [step('s1', 'a'), step('s2', 'c', 'b')]
const r1 = reconcileSteps(pages(['c', 'a', 'b']), steps1, ['b'], '主屏')
ok(r1.steps.length === 2 && r1.steps[0].main.pageId === 'a' && r1.steps[1].secondary.pageId === 'b', '场景4: 页面重排后引用保持不变')
ok(r1.report.removedNodeRefs === 0 && r1.report.added === 0, '场景4: 无引用丢失、无新增')

// 场景 3：前面插入新页 -> 原映射不变
const r2 = reconcileSteps(pages(['new1', 'a', 'b', 'c']), steps1, ['b'], '主屏')
ok(r2.steps[0].main.pageId === 'a' && r2.steps[1].secondary.pageId === 'b', '场景3: 前插新页后原映射不乱')
ok(r2.report.added === 1 && r2.unmapped.includes('new1'), '场景3: 新页进入未编排池')

// 场景 5：删除被引用页面 -> 引用清除 + 空步骤删除 + 被引用步骤保留
const steps3 = [step('s1', 'a'), step('s2', 'gone', undefined), step('s3', undefined, 'b')]
const r3 = reconcileSteps(pages(['a', 'b']), steps3, [], '主屏')
ok(r3.steps.length === 2, '场景5: 空步骤已删除（剩 2 步）')
ok(r3.steps[0].main.pageId === 'a' && r3.steps[0].secondary?.action !== 'goto', '场景5: 引用被删页面的 target 已清空为 keep')
ok(r3.report.removedSteps.includes('s2'), '场景5: 提示被移除的空步骤')
ok(r3.steps[1].secondary.pageId === 'b', '场景5: 部分失效的步骤保留另一屏引用')

// 场景 6：新增页面不自动加入序列（c 已被 s2 引用，只有 d 是新页）
const r4 = reconcileSteps(pages(['a', 'b', 'c', 'd']), steps1, ['b'], '主屏')
ok(r4.report.added === 1 && r4.unmapped.includes('d') && !r4.unmapped.includes('c'), '场景6: 新增页进池、不自动编排')

// 未编排池中被删页面清理
const r5 = reconcileSteps(pages(['a', 'b']), steps1, ['b', 'ghost'], '主屏')
ok(!r5.unmapped.includes('ghost') && r5.unmapped.includes('b'), '未编排池同步清理已删页面')

// 双引用步骤两屏都删 -> 整步删除
const r6 = reconcileSteps(pages(['a']), [step('s9', 'x', 'y')], [], '主屏')
ok(r6.steps.length === 0 && r6.report.removedSteps.includes('s9'), '双屏引用都失效时整步删除')

// tablet/mqtt 事件步骤：页面引用全删但事件仍在 -> 步骤保留
const r7 = reconcileSteps(pages(['a']), [step('s10', 'x', 'y', { tablet: { scene: 's1' } })], [], '主屏')
ok(r7.steps.length === 1 && r7.steps[0].main?.action !== 'goto' && r7.steps[0].tablet?.scene === 's1', '事件步骤仅清除页面引用、保留步骤')

// 冷启动/双内容源：主屏清单只能对账主屏引用，绝不能误删副屏引用（反之亦然）
const crossRole = [step('cross', 'main-a', 'secondary-b')]
const mainOnly = reconcileSteps(pages(['main-a']), crossRole, [], '主屏', 'main')
ok(mainOnly.steps[0].secondary.pageId === 'secondary-b', '主屏对账不删除副屏引用')
const secondaryOnly = reconcileSteps(pages(['secondary-b']), crossRole, [], '副屏', 'secondary')
ok(secondaryOnly.steps[0].main.pageId === 'main-a', '副屏对账不删除主屏引用')

console.log(`\n结果: ${pass} 通过`)
process.exit(pass === 20 ? 0 : 1)
