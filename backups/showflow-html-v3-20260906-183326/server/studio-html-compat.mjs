/** Display mapping only. External IDs and LCD snapshots come from original Markdown.
 * A missing mapping falls back to that ORIGINAL Reveal page; never guess by page number.
 * The reviewed 16-page HTML keeps its internal IDs, separate from wire-protocol IDs.
 */
import crypto from 'node:crypto'
import { parseMarkdownManifest } from './studio-html-md-manifest.mjs'

export const REVIEWED_HTML_IDS = ['opening','team','overview-start','stage-1-detail-1','overview-1','stage-2-detail-1','overview-2','stage-3-detail-1','overview-3','stage-4-detail-1','stage-4-detail-2','overview-4','stage-5-detail-1','stage-5-detail-2','overview-5','closing']
export const LEGACY_DISPLAY_MAP = Object.freeze({
  'flow-01':'team',
  // flow-02 explains three evidence periods; no matching page in the compact HTML.
  'flow-03':'overview-start',
  'flow-04':'stage-1-detail-1',
  'flow-05':'stage-2-detail-1',
  'flow-06':'stage-3-detail-1',
  'flow-07':'stage-4-detail-1',
  'flow-08':'stage-4-detail-2',
  // flow-09 (synchronized replay) / flow-10 (key frame) retain original pages.
  'flow-11':'stage-5-detail-1',
  'flow-12':'stage-5-detail-1',
  'flow-13':'stage-5-detail-1',
  'flow-14':'stage-5-detail-2',
  'flow-15':'stage-5-detail-2',
  'flow-16':'closing',
})
// Explicit semantic correspondences for previously-rebound HTML IDs. The values
// are source-page references, NOT newly synthesized hardware/LCD states.
const ALIAS_LCD_SOURCE = Object.freeze({team:'flow-01','overview-start':'flow-03',
  'stage-1-detail-1':'flow-04','stage-2-detail-1':'flow-05','stage-3-detail-1':'flow-06',
  'stage-4-detail-1':'flow-07','stage-4-detail-2':'flow-08',
  'stage-5-detail-1':'flow-11','stage-5-detail-2':'flow-15',closing:'flow-16'})
export function buildCompatibleConfig(theme, markdown) {
  const protocolManifest = parseMarkdownManifest(markdown)
  const legacy = new Map(protocolManifest.map(p=>[p.id,p]))
  const displayManifest = theme.manifest.map(({lcd, ...p})=>p)
  const display = new Map(displayManifest.map(p=>[p.id,p]))
  const reviewed = theme.adapter === 'zhizheng' && JSON.stringify(displayManifest.map(p=>p.id)) === JSON.stringify(REVIEWED_HTML_IDS)
  // Custom mapping must be explicit and supplied as display-only metadata.
  const mapping = reviewed ? LEGACY_DISPLAY_MAP : (theme.protocolPageMap || {})
  const bindings = Object.create(null)
  for (const p of protocolManifest) {
    const target = Object.hasOwn(mapping,p.id) ? mapping[p.id] : (display.has(p.id) ? p.id : null)
    if (target && !display.has(target)) throw new Error(`页面映射目标不存在：${p.id} → ${target}`)
    bindings[p.id] = target ? { kind:'html', targetId:target } : { kind:'native', targetId:p.id }
  }
  // Additive aliases: existing original schemes AND schemes rebound by v1 continue
  // to work. Original IDs, order, titles and LCD objects are never overwritten.
  const aliases = []
  for (const p of displayManifest) {
    if (legacy.has(p.id)) continue
    bindings[p.id] = {kind:'html', targetId:p.id}
    const source = reviewed && ALIAS_LCD_SOURCE[p.id] ? legacy.get(ALIAS_LCD_SOURCE[p.id]) : null
    aliases.push({...p,index:protocolManifest.length+aliases.length+1,
      title:`HTML · ${p.title}`,lcd:source?.lcd ? structuredClone(source.lcd) : null})
  }
  const signature = crypto.createHash('sha256').update(theme.fingerprint).update(markdown).update(JSON.stringify(bindings)).digest('hex')
  return {...theme, runtimeVersion:'studio-html-compat/2.0', contentFingerprint:theme.fingerprint,
    fingerprint:signature, displayManifest, protocolManifest,
    manifest:[...protocolManifest,...aliases], bindings,
    originalPageCount:protocolManifest.length, pageCount:displayManifest.length,
    fallbackIds:protocolManifest.filter(p=>bindings[p.id].kind==='native').map(p=>p.id),
    mappingNotice:reviewed ? '按内容保留原 flow-* ID；三时段证据、事故回溯、关键帧三维化保留原 Reveal 画面。' : '仅显式同名/映射 ID 使用 HTML；其余 ID 保留原 Reveal 画面。',
    nativeUrl:'/reveal/?content=markdown&displayOnly=1',
  }
}
