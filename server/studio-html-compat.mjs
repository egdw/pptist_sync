/** Display mapping only. External IDs and LCD snapshots come from original Markdown.
 * A missing mapping falls back to that ORIGINAL Reveal page; never guess by page number.
 * The reviewed 16-page HTML keeps its internal IDs, separate from wire-protocol IDs.
 */
import crypto from 'node:crypto'
import { parseMarkdownManifest } from './studio-html-md-manifest.mjs'

export const REVIEWED_HTML_IDS = ['opening','team','overview-start','stage-1-detail-1','overview-1','stage-2-detail-1','overview-2','stage-3-detail-1','overview-3','stage-4-detail-1','stage-4-detail-2','overview-4','stage-5-detail-1','stage-5-detail-2','overview-5','closing']
export const LEGACY_DISPLAY_MAP = Object.freeze({
  // Preserve the teacher-facing public IDs flow-01..flow-16, but display the
  // reviewed HTML pages in their real 1..16 order. The wire protocol IDs do
  // not change; only the renderer behind each public ID changes.
  'flow-01':'opening',
  'flow-02':'team',
  'flow-03':'overview-start',
  'flow-04':'stage-1-detail-1',
  'flow-05':'overview-1',
  'flow-06':'stage-2-detail-1',
  'flow-07':'overview-2',
  'flow-08':'stage-3-detail-1',
  'flow-09':'overview-3',
  'flow-10':'stage-4-detail-1',
  'flow-11':'stage-4-detail-2',
  'flow-12':'overview-4',
  'flow-13':'stage-5-detail-1',
  'flow-14':'stage-5-detail-2',
  'flow-15':'overview-5',
  'flow-16':'closing',
})
// Explicit semantic correspondences for previously-rebound HTML IDs. The values
// are source-page references, NOT newly synthesized hardware/LCD states.
const ALIAS_LCD_SOURCE = Object.freeze({team:'flow-01','overview-start':'flow-03',
  'stage-1-detail-1':'flow-04','stage-2-detail-1':'flow-05','stage-3-detail-1':'flow-06',
  'stage-4-detail-1':'flow-07','stage-4-detail-2':'flow-08',
  'stage-5-detail-1':'flow-11','stage-5-detail-2':'flow-15',closing:'flow-16'})
function clone(value) { return value == null ? value : structuredClone(value) }

/**
 * Build the public 16-page manifest shown to ShowFlow.
 * Public IDs/LCD semantics remain from the teacher's Markdown; titles/subtitles
 * come from the actual HTML renderer so the editor shows what the audience sees.
 */
export function buildCompatibleConfig(theme, markdown) {
  const protocolManifest = parseMarkdownManifest(markdown)
  const legacy = new Map(protocolManifest.map(p => [p.id, p]))
  const displayManifest = theme.manifest.map(({ lcd, ...p }) => p)
  const display = new Map(displayManifest.map(p => [p.id, p]))
  const reviewed = theme.adapter === 'zhizheng' && JSON.stringify(displayManifest.map(p => p.id)) === JSON.stringify(REVIEWED_HTML_IDS)
  const mapping = reviewed ? LEGACY_DISPLAY_MAP : (theme.protocolPageMap || {})
  const bindings = Object.create(null)

  for (const p of protocolManifest) {
    const target = Object.hasOwn(mapping, p.id) ? mapping[p.id] : (display.has(p.id) ? p.id : null)
    if (target && !display.has(target)) throw new Error(`页面映射目标不存在：${p.id} → ${target}`)
    bindings[p.id] = target ? { kind: 'html', targetId: target } : { kind: 'native', targetId: p.id }
  }

  // Keep internal HTML IDs as additive command aliases for compatibility with
  // schemes made during earlier testing, but do not expose them as extra pool pages.
  for (const p of displayManifest) {
    if (!Object.hasOwn(bindings, p.id)) bindings[p.id] = { kind: 'html', targetId: p.id }
  }

  const publicManifest = protocolManifest.map((p, i) => {
    const binding = bindings[p.id]
    const shown = binding?.kind === 'html' ? display.get(binding.targetId) : null
    return {
      ...p,
      index: i + 1,
      title: shown?.title || p.title,
      subtitle: shown?.subtitle || shown?.stage || p.subtitle,
      // p.stage / p.lcd stay teacher-original. They feed existing LCD semantics.
      displayTargetId: shown?.id || p.id,
      displayKind: shown ? 'html' : 'native',
    }
  })

  const signature = crypto.createHash('sha256')
    .update(theme.fingerprint)
    .update(markdown)
    .update(JSON.stringify(bindings))
    .digest('hex')

  return {
    ...theme,
    runtimeVersion: 'studio-html-compat/2.0',
    contentFingerprint: theme.fingerprint,
    fingerprint: signature,
    displayManifest,
    protocolManifest,
    // Exactly 16 public pool pages; no duplicate HTML aliases in the editor.
    manifest: publicManifest,
    bindings,
    originalPageCount: protocolManifest.length,
    pageCount: displayManifest.length,
    fallbackIds: protocolManifest.filter(p => bindings[p.id].kind === 'native').map(p => p.id),
    mappingNotice: reviewed
      ? '主控仍使用 flow-01～flow-16；右侧页面池显示当前 HTML 的真实 16 页名称。'
      : '仅显式同名/映射 ID 使用 HTML；其余 ID 保留原 Reveal 画面。',
    nativeUrl: '/reveal/?content=markdown&displayOnly=1',
  }
}

function attr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ')
}

/**
 * Old deployed ShowFlow frontends still read /api/studio/slides/active/raw.
 * Project the HTML-visible titles onto the teacher's original flow-* IDs while
 * reproducing original LCD metadata exactly. This changes editor labels only;
 * protocol IDs and LCD source semantics remain unchanged.
 */
export function buildShowFlowProjectionMarkdown(theme, markdown) {
  const config = buildCompatibleConfig(theme, markdown)
  if (config.kind !== 'html') return markdown
  return config.manifest.map(page => {
    const lcd = page.lcd
    const attrs = [`data-page-id="${attr(page.id)}"`, `data-title="${attr(page.title)}"`]
    if (page.tabletScene) attrs.push(`data-tablet-scene="${attr(page.tabletScene)}"`)
    if (lcd) {
      if (lcd.stage) attrs.push(`data-stage="${attr(lcd.stage)}"`)
      if (lcd.lead) attrs.push(`data-lead="${attr(lcd.lead)}"`)
      if (Array.isArray(lcd.active) && lcd.active.length) attrs.push(`data-active="${attr(lcd.active.join(','))}"`)
      const collab = ['manager', 'platform', 'twin', 'hardware']
        .map(role => `${role}=${lcd.roles?.[role]?.task || ''}`)
        .join(';')
      attrs.push(`data-collab="${attr(collab)}"`)
    }
    const subtitle = String(page.subtitle || '').replace(/\r?\n/g, ' ').trim()
    return `<!-- .slide: ${attrs.join(' ')} -->\n# ${page.title}\n${subtitle || 'HTML 流程页面'}`
  }).join('\n\n---\n\n') + '\n'
}
