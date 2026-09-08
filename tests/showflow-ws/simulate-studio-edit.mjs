/* 模拟 Studio 修改页面内容：改标题 + 新增一页 */
const BASE = 'http://127.0.0.1:8686'
async function main() {
  const md1 = await (await fetch(BASE + '/api/studio/slides/draft/raw')).text()
  const pages = md1.replace(/\r\n/g, '\n').split(/^---\s*$/m)
  pages[0] = pages[0].replace('# 智证先锋', '# 智证先锋（Studio 修改版）')
  pages.push('<!-- .slide: class="action" data-page-id="studio-test-1" data-stage="新增阶段" -->\n# 新增的测试页\nStudio 加的')
  const r = await fetch(BASE + '/api/studio/slides', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: pages.join('\n\n---\n\n') }),
  })
  console.log('PUT status:', r.status, await r.text())
  const check = await (await fetch(BASE + '/api/studio/slides/draft/raw')).text()
  console.log('draft pages:', check.split(/^---\s*$/m).length, '| has studio page:', check.includes('studio-test-1'))
}
main()
