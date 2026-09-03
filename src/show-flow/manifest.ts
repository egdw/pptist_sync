/**
 * Reveal Markdown 页面清单解析器
 *
 * 按 Reveal 水平分页分隔符 `---` 切分 section；
 * 每个 section 取第一个 H1 作为页面标题，读取 `<!-- .slide: ... -->` 注释上的
 * data-page-id / data-stage / data-tablet-scene 联动元数据。
 *
 * 未显式标注 data-page-id 时，使用 section 原文的稳定内容 hash 作为页面 ID ——
 * 强烈建议在 MD 中显式标注 data-page-id，内容 hash 在该页文本被修改后会变化。
 */
import { nanoid } from 'nanoid'
import type { Slide } from '@/types/slides'
import type { PageManifest } from './types'

const SECTION_SEPARATOR = /^---\s*$/m
const SLIDE_COMMENT_RE = /<!--\s*\.slide:\s*([\s\S]*?)-->/
const ATTR_RE = /data-([a-z0-9-]+)\s*=\s*"([^"]*)"/g
const H1_RE = /^\s*#\s+(.+?)\s*$/m

export function stablePageHash(text: string): string {
  // djb2 变体，对 section 原文生成稳定 32bit hash
  let h = 5381
  const normalized = text.replace(/\r\n/g, '\n').trim()
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0
  }
  return `md-${(h >>> 0).toString(36)}`
}

function parseSlideAttrs(section: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const comment = section.match(SLIDE_COMMENT_RE)
  if (!comment) return attrs
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(comment[1]))) {
    attrs[m[1]] = m[2]
  }
  return attrs
}

export function parseMarkdownManifest(md: string): PageManifest[] {
  const lines = md.replace(/\r\n/g, '\n')
  const rawSections = lines.split(SECTION_SEPARATOR)
  const manifest: PageManifest[] = []
  for (const section of rawSections) {
    const trimmed = section.trim()
    if (!trimmed) continue
    const attrs = parseSlideAttrs(trimmed)
    const h1 = trimmed.match(H1_RE)
    const title = (attrs['title'] || (h1 ? h1[1] : '')).trim()
    // 副标题：H1 之后的第一行非空正文（跳过注释/分隔线/表格分隔），用于编排时辅助识别
    let subtitle: string | undefined
    if (h1) {
      const afterH1 = trimmed.slice((h1.index ?? 0) + h1[0].length)
      for (const line of afterH1.split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('<!--') || t.startsWith('#') || /^\|[\s:|-]+\|$/.test(t)) continue
        subtitle = t.replace(/\*\*/g, '').slice(0, 60)
        break
      }
    }
    manifest.push({
      id: attrs['page-id'] || stablePageHash(trimmed),
      index: manifest.length + 1,
      title: title || `未命名页 ${manifest.length + 1}`,
      subtitle,
      stage: attrs['stage'] || undefined,
      tabletScene: attrs['tablet-scene'] || undefined,
    })
  }
  return manifest
}

export function markdownManifestVersion(md: string): string {
  return stablePageHash(md).slice(0, 12) + '-' + md.length.toString(36)
}

/** 由 PPTist slides 生成 PageManifest（复用永久 slideId / remark 备注） */
export function buildPptistManifest(slides: Slide[]): PageManifest[] {
  return slides.map((slide, i) => ({
    id: slide.id,
    index: i + 1,
    title: extractSlideTitle(slide, i + 1),
    notes: slide.remark || '',
  }))
}

function extractSlideTitle(slide: Slide, index: number): string {
  const textEls = slide.elements.filter(el => ['text', 'shape'].includes(el.type))
  for (const el of textEls) {
    const content = (el as { text?: { content?: string } }).text?.content || ''
    const line = content
      .replace(/<[^>]+>/g, ' ')
      .split('\n')
      .map(s => s.trim())
      .find(Boolean)
    if (line) return line.slice(0, 40)
  }
  return `第 ${index} 页`
}

/** 防重：nanoid 快捷封装 */
export function genId(prefix: string): string {
  return `${prefix}-${nanoid(8)}`
}
