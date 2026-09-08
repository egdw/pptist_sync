/** No upload code is evaluated. Run: node tests/studio/html-theme.test.mjs [final.html] */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { inspectHtml, HTML_MAX_BYTES } from '../../server/studio-html.mjs'
import { createStudioService } from '../../server/studio-service.mjs'
let count = 0
async function test(name, run) { await run(); count++; console.log(`✓ ${name}`) }
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-html-'))
const revealDir = path.join(root, 'reveal'), dataDir = path.join(root, 'data/studio')
await fs.mkdir(revealDir, { recursive: true }); await fs.writeFile(path.join(revealDir, 'slides.md'), '# Old Markdown\n'); await fs.writeFile(path.join(revealDir, 'theme.css'), 'body { color: blue }')
const flowData = { team: [{}, {}, {}, {}], chapters: [{ title: '联调' }], pages: [{ id: 'cover', index: 0, title: '首页', kind: 'cover' }, { id: 'joint', index: 1, title: '联合工作', kind: 'detail', chapter: 0, lead: 3, coLeads: [1, 3], team: ['统筹', '平台接收', '准备仿真', '设备联调'] }] }
const sample = Buffer.from(`<!doctype html><html><head><title>主题</title></head><body><script id="flow-data" type="application/json">${JSON.stringify(flowData)}</script><script>globalThis.UPLOAD_WAS_EXECUTED=true;window.ZhizhengFlow={};</script></body></html>`)
let service = createStudioService({ rootDir: root, revealDir, dataDir }); await service.init()
try {
  await test('auto-detect stable multi-page JSON without executing JS', () => { const m = inspectHtml(sample); assert.equal(m.pageCount, 2); assert.equal(m.adapter, 'zhizheng'); assert.equal(globalThis.UPLOAD_WAS_EXECUTED, undefined); assert.deepEqual(m.manifest.map(p => p.id), ['cover', 'joint']) })
  await test('LCD snapshot uses the original schema', () => { const m = inspectHtml(sample); assert.equal(m.manifest[1].lcd.source.type, 'reveal-md'); assert.equal(m.manifest[1].lcd.lead, 'hardware'); assert.equal(m.manifest[1].lcd.roles.platform.task, '平台接收') })
  await test('generic HTML is explicitly one page', () => { const m = inspectHtml(Buffer.from('<html><body>Hello</body></html>')); assert.equal(m.pageCount, 1); assert.match(m.warning, /单页/) })
  await test('reject fragment', () => assert.throws(() => inspectHtml(Buffer.from('<div>Hello</div>')), /完整/))
  await test('reject non-UTF8', () => assert.throws(() => inspectHtml(Buffer.from([0xff, 0xfe])), /UTF-8/))
  await test('reject oversize', () => assert.throws(() => inspectHtml(Buffer.alloc(HTML_MAX_BYTES + 1)), /32MB/))
  await test('reject bad JSON', () => assert.throws(() => inspectHtml(Buffer.from('<html><body><script id="flow-data" type="application/json">{bad}</script></body></html>')), /JSON/))
  await test('reject duplicate stable IDs', () => assert.throws(() => inspectHtml(Buffer.from(sample.toString().replace('"id":"joint"', '"id":"cover"'))), /重复/))
  await test('reject invalid stable IDs', () => assert.throws(() => inspectHtml(Buffer.from(sample.toString().replace('"id":"joint"', '"id":"../server"'))), /非法/))
  await test('reject position mismatch', () => assert.throws(() => inspectHtml(Buffer.from(sample.toString().replace('"index":1', '"index":99'))), /index/))
  await test('explicit manifest contract', () => { const m = inspectHtml(Buffer.from('<html><body><script id="showflow-manifest" type="application/json">{"format":"showflow-html/1.0","adapter":"showflow","pages":[{"id":"a","title":"A"}]}</script></body></html>')); assert.equal(m.adapter, 'showflow') })
  let first
  await test('upload in original theme library does not publish', async () => { first = await service.uploadTheme('测试主题.html', sample); assert.equal(first.kind, 'html'); assert.equal((await service.renderConfig()).kind, 'css'); assert.equal((await service.status()).dirty, false) })
  await test('same filename creates a distinct immutable version', async () => { const second = await service.uploadTheme('测试主题.html', sample); assert.notEqual(first.id, second.id) })
  await test('list distinguishes HTML and CSS', async () => { const entries = await service.listThemes(); assert.equal(entries[0].kind, 'css'); assert.equal(entries.find(t => t.id === first.id).pageCount, 2) })
  await test('Draft selection only affects Draft', async () => { await service.selectDraftTheme(first.id); assert.equal((await service.renderConfig('draft')).kind, 'html'); assert.equal((await service.renderConfig('active')).kind, 'css'); assert.equal((await service.status()).dirty, true) })
  await test('download preserves exact original bytes', async () => { const e = await service.exportTheme('draft'); assert.deepEqual(e.data, sample); assert.equal(e.filename, '测试主题.html') })
  await test('CSS editor refuses HTML without changing it', async () => { await assert.rejects(() => service.saveDraftThemeCss('body{}'), /HTML/); assert.deepEqual((await service.getHtml(first.id)).data, sample) })
  await test('publish promotes HTML but does not overwrite Markdown', async () => { await service.publish('HTML'); assert.equal((await service.renderConfig()).id, first.id); assert.equal((await service.getSlides('active')).markdown, '# Old Markdown\n') })
  await test('published/draft themes cannot be deleted', async () => assert.rejects(() => service.deleteTheme(first.id), /引用|不能/))
  await test('quick consecutive publications have distinct history IDs', async () => { await service.publish('again'); assert.equal((await service.versions()).length, 2) })
  await test('restarting service restores HTML active state', async () => { service = createStudioService({ rootDir: root, revealDir, dataDir }); await service.init(); assert.equal((await service.renderConfig()).id, first.id) })
  await test('switch to CSS retains HTML in library', async () => { await service.selectDraftTheme('default'); await service.publish('CSS'); assert.equal((await service.renderConfig()).kind, 'css'); assert.equal((await service.themeInfo(first.id)).kind, 'html') })
  await test('restore HTML history is Draft only until publish', async () => { const version = (await service.versions()).find(v => v.revealTheme === first.id); await service.restore(version.id); assert.equal((await service.renderConfig('draft')).id, first.id); assert.equal((await service.renderConfig()).kind, 'css'); await service.publish('restored'); assert.equal((await service.renderConfig()).id, first.id) })
  await test('history-referenced themes cannot be removed after switching', async () => { await service.selectDraftTheme('default'); await service.publish(); await assert.rejects(() => service.deleteTheme(first.id), /引用/) })
  await test('HTML byte fingerprints are stable', async () => assert.equal((await service.themeInfo(first.id)).fingerprint, crypto.createHash('sha256').update(sample).digest('hex')))
  await test('path traversal is rejected', async () => { await assert.rejects(() => service.themeInfo('../x'), /无效/); await assert.rejects(() => service.getHtml('..'), /无效/); await assert.rejects(() => service.selectDraftTheme('../'), /无效/) })
  await test('invalid upload never changes active content', async () => { await assert.rejects(() => service.uploadTheme('bad.html', Buffer.from('bad')), /完整/); assert.equal((await service.renderConfig()).kind, 'css') })
  await test('CSS edit clones active CSS, preserving published copy', async () => { await service.saveDraftThemeCss('body{color:red}'); assert.equal((await service.renderConfig()).id, 'default'); assert.equal(await fs.readFile(path.join(revealDir, 'theme.css'), 'utf8'), 'body { color: blue }'); assert.equal((await service.status()).dirty, true) })
  await test('queued theme selection and publish cannot lose the selected Draft', async () => {
    await Promise.all([service.selectDraftTheme(first.id), service.publish('queued')])
    assert.equal((await service.renderConfig()).id, first.id)
  })
  await test('Active ignores a Draft-only theme override', async () => {
    assert.equal((await service.renderConfig('active', 'default')).id, first.id)
    assert.equal((await service.renderConfig('draft', 'default')).id, 'default')
  })
  if (process.argv[2]) {
    await test('approved final HTML: all 16 IDs, no lost double-lead metadata', async () => { const actual = inspectHtml(await fs.readFile(process.argv[2])); assert.equal(actual.pageCount, 16); assert.equal(actual.manifest[3].id, 'stage-1-detail-1'); assert.equal(actual.manifest[15].id, 'closing'); assert.equal(actual.adapter, 'zhizheng') })
  }
  console.log(`\n${count} HTML/theme assertions groups passed`)
} finally { await fs.rm(root, { recursive: true, force: true }) }
