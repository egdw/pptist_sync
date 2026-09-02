/**
 * 演讲者备注（remark）→ 纯文本转换
 *
 * - remark 在编辑器中保存为 ProseMirror 输出的 HTML（如 <p>、<ul><li>、<strong> 等），
 *   PPTX 导入的备注则可能是纯文本。此处自动区分两种情况。
 * - 仅当内容中出现已知的富文本标记时才按 HTML 解析，避免把普通文本中的
 *   比较符号（如 "a<b>c"、"1 < 2"）误当作标签处理。
 * - 解析使用自研的轻量字符级扫描器，不创建任何 DOM 节点，
 *   因此备注中的脚本内容既不会被执行，也不会被当作指令。
 * - 保留中文、标点与换行；块级标签（段落、列表项等）转换为换行，<br> 转换为换行，
 *   HTML 实体（含命名实体与数字实体）转换为对应字符。
 */

// 仅当出现“块级结构标签”时才按 HTML 解析：PPTist 备注编辑器保存的富文本
// 必然带有 <p> 等块级包裹；而普通文本中的 "<b>"、"a<i>c" 这类尖括号内容
// 不会被误判为富文本，从而原样保留（避免比较符号等内容丢失）。
const RICH_TAG_PATTERN =
  /<\/?(?:p|div|br|hr|ul|ol|li|h[1-6]|blockquote|table|thead|tbody|tr|td|th|pre|section)(?:\s|>|\/)/i

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  middot: '·',
  bull: '•',
  para: '¶',
  sect: '§',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'table', 'thead', 'tbody', 'tr', 'pre', 'section',
])
// 内容整体忽略的标签（不输出其中的文本）
const SKIP_CONTENT_TAGS = new Set(['script', 'style'])

interface TagToken {
  type: 'open' | 'close'
  name: string
}

export function remarkToPlainText(remark: string | null | undefined): string {
  if (typeof remark !== 'string') return ''
  const text = remark.replace(/\r\n?/g, '\n')
  if (!text.includes('<')) return text
  // 含有 "<" 但不构成已知的富文本标记时，视为普通文本原样保留
  if (!RICH_TAG_PATTERN.test(text)) return text
  return htmlToPlainText(text)
}

function htmlToPlainText(html: string): string {
  let result = ''
  let skipStack: string[] = []
  let i = 0
  let lineStarted = true

  const appendText = (str: string) => {
    if (!str) return
    result += str
    lineStarted = false
  }
  const appendBreak = () => {
    if (!lineStarted) {
      result += '\n'
      lineStarted = true
    }
  }

  while (i < html.length) {
    const char = html[i]

    if (char === '<') {
      // 注释：整体跳过
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4)
        i = end === -1 ? html.length : end + 3
        continue
      }

      const tag = readTag(html, i)
      if (tag) {
        const name = tag.token.name.toLowerCase()
        i = tag.nextIndex

        if (SKIP_CONTENT_TAGS.has(name)) {
          if (tag.token.type === 'open') skipStack.push(name)
          else skipStack = skipStack.filter(item => item !== name)
        }
        else if (!skipStack.length) {
          if (name === 'br' || name === 'hr') {
            appendBreak()
          }
          else if (
            (tag.token.type === 'open' && BLOCK_TAGS.has(name)) ||
            (tag.token.type === 'close' && BLOCK_TAGS.has(name))
          ) {
            // 块级边界产生换行；行内标签（strong、span 等）仅剥离标记，不影响文本
            appendBreak()
          }
        }
        continue
      }

      if (!skipStack.length) {
        // 非标签的孤立 "<"，按普通文本处理
        appendText('<')
      }
      i += 1
      continue
    }

    // script/style 内容整体跳过（不执行、不输出）
    if (skipStack.length) {
      i += 1
      continue
    }

    if (char === '&') {
      const entity = readEntity(html, i)
      if (entity) {
        appendText(entity.value)
        i = entity.nextIndex
        continue
      }
    }

    // 备注文本中的字面换行按换行保留（PPTX 导入的备注常为“单段落内含 \n”的形式）；
    // 标签边界产生的换行之后，此处为空行起始，不会产生多余空行
    if (char === '\n') {
      appendBreak()
      i += 1
      continue
    }

    appendText(char)
    i += 1
  }

  return result
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface ReadTagResult {
  token: TagToken
  nextIndex: number
}

// 读取一个完整的起始/结束标签；无法构成合法标签时返回 null
function readTag(html: string, start: number): ReadTagResult | null {
  let i = start + 1
  let isClose = false
  if (html[i] === '/') {
    isClose = true
    i += 1
  }
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(i, i + 20))
  if (!nameMatch) return null
  const name = nameMatch[0]
  i += name.length

  // 跳过属性，注意引号内的 ">" 不结束标签
  while (i < html.length) {
    const char = html[i]
    if (char === '"' || char === "'") {
      const end = html.indexOf(char, i + 1)
      if (end === -1) return null
      i = end + 1
      continue
    }
    if (char === '>') {
      return { token: { type: isClose ? 'close' : 'open', name }, nextIndex: i + 1 }
    }
    i += 1
  }
  return null
}

interface ReadEntityResult {
  value: string
  nextIndex: number
}

function readEntity(html: string, start: number): ReadEntityResult | null {
  const end = html.indexOf(';', start)
  if (end === -1 || end - start > 12) return null
  const body = html.slice(start + 1, end)
  if (!body) return null

  if (body[0] === '#') {
    const isHex = body[1] === 'x' || body[1] === 'X'
    const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10)
    if (Number.isNaN(code) || code < 1 || code > 0x10ffff) return null
    try {
      return { value: String.fromCodePoint(code), nextIndex: end + 1 }
    }
    catch {
      return null
    }
  }

  const named = NAMED_ENTITIES[body.toLowerCase()]
  if (named === undefined) return null
  return { value: named, nextIndex: end + 1 }
}
