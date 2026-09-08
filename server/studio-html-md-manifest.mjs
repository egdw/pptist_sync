/* Generated from the teacher's original Markdown/LCD parser. Do not infer LCD from HTML.
 * Source files are unmodified; tests compare full parsed objects. */
const LCD_ROLES = ["manager", "platform", "twin", "hardware"];
export const isLcdRole = (value) => LCD_ROLES.includes(value);
export function createLcdSceneState(source, values) {
    const lead = (values.lead || '').trim();
    const active = (values.active || '').split(',').map(v => v.trim()).filter(isLcdRole);
    return {
        source,
        stage: (values.stage || '').trim(),
        lead: isLcdRole(lead) ? lead : null,
        active,
        roles: Object.fromEntries(LCD_ROLES.map(role => [role, { task: (values[role] || '').trim() }])),
    };
}

export function parseMarkdownLcd(attrs, pageId) {
    const hasLcdData = ['stage', 'lead', 'active', 'collab'].some(key => attrs[key] !== undefined);
    if (!hasLcdData)
        return null;
    const values = {
        stage: attrs.stage || '', lead: attrs.lead || '', active: attrs.active || '',
    };
    for (const item of (attrs.collab || '').split(';')) {
        const equals = item.indexOf('=');
        if (equals > 0)
            values[item.slice(0, equals).trim().toLowerCase()] = item.slice(equals + 1).trim();
    }
    return createLcdSceneState({ type: 'reveal-md', pageId }, values);
}

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
const SECTION_SEPARATOR = /^---\s*$/m;
const SLIDE_COMMENT_RE = /<!--\s*\.slide:\s*([\s\S]*?)-->/;
const ATTR_RE = /data-([a-z0-9-]+)\s*=\s*"([^"]*)"/g;
const H1_RE = /^\s*#\s+(.+?)\s*$/m;
export function stablePageHash(text) {
    // djb2 变体，对 section 原文生成稳定 32bit hash
    let h = 5381;
    const normalized = text.replace(/\r\n/g, '\n').trim();
    for (let i = 0; i < normalized.length; i++) {
        h = ((h << 5) + h + normalized.charCodeAt(i)) | 0;
    }
    return `md-${(h >>> 0).toString(36)}`;
}
function parseSlideAttrs(section) {
    const attrs = {};
    const comment = section.match(SLIDE_COMMENT_RE);
    if (!comment)
        return attrs;
    let m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(comment[1]))) {
        attrs[m[1]] = m[2];
    }
    return attrs;
}
export function parseMarkdownManifest(md) {
    const lines = md.replace(/\r\n/g, '\n');
    const rawSections = lines.split(SECTION_SEPARATOR);
    const manifest = [];
    for (const section of rawSections) {
        const trimmed = section.trim();
        if (!trimmed)
            continue;
        const attrs = parseSlideAttrs(trimmed);
        const h1 = trimmed.match(H1_RE);
        const title = (attrs['title'] || (h1 ? h1[1] : '')).trim();
        // 副标题：H1 之后的第一行非空正文（跳过注释/分隔线/表格分隔），用于编排时辅助识别
        let subtitle;
        if (h1) {
            const afterH1 = trimmed.slice((h1.index ?? 0) + h1[0].length);
            for (const line of afterH1.split('\n')) {
                const t = line.trim();
                if (!t || t.startsWith('<!--') || t.startsWith('#') || /^\|[\s:|-]+\|$/.test(t))
                    continue;
                subtitle = t.replace(/\*\*/g, '').slice(0, 60);
                break;
            }
        }
        const id = attrs['page-id'] || stablePageHash(trimmed);
        manifest.push({
            id,
            index: manifest.length + 1,
            title: title || `未命名页 ${manifest.length + 1}`,
            subtitle,
            stage: attrs['stage'] || undefined,
            tabletScene: attrs['tablet-scene'] || undefined,
            lcd: parseMarkdownLcd(attrs, id),
        });
    }
    return manifest;
}
export function markdownManifestVersion(md) {
    return stablePageHash(md).slice(0, 12) + '-' + md.length.toString(36);
}

