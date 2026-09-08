/* 修复封面页被误写的排版 class：action → team（保留用户其余内容） */
const BASE = 'http://127.0.0.1:8686'
async function main() {
  const md = await (await fetch(BASE + '/api/studio/slides/draft/raw')).text()
  const pages = md.replace(/\r\n/g, '\n').split(/^---\s*$/m)
  const idx = pages.findIndex(p => p.includes('Studio 修改版'))
  if (idx === -1) { console.log('未找到目标页'); return }
  pages[idx] = pages[idx].replace('class="action"', 'class="team"')
  const r = await fetch(BASE + '/api/studio/slides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: pages.join('\n\n---\n\n') }),
  })
  console.log('PUT:', r.status)
  const check = pages[idx].match(/class="([^"]+)"/)?.[1]
  console.log('封面页 class 恢复为:', check)
}
main()
