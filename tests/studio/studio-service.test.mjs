import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { createStudioService } from '../../server/studio-service.mjs'

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptist-studio-test-'))
try {
  const revealDir = path.join(root, 'reveal')
  const dataDir = path.join(root, 'data', 'studio')
  await fsp.mkdir(revealDir, { recursive: true })
  await fsp.writeFile(path.join(revealDir, 'slides.md'), '# A\n\n---\n\n# B\n')
  const service = createStudioService({ rootDir: root, revealDir, dataDir })
  await service.init()
  assert.equal((await service.getSlides('active')).markdown.includes('# A'), true)
  await service.saveDraft('# Draft\n')
  assert.equal((await service.status()).dirty, true)
  assert.equal((await service.getSlides('active')).markdown.includes('# Draft'), false, 'Draft must not leak into Active')
  await service.publish('acceptance')
  assert.equal((await service.getSlides('active')).markdown, '# Draft\n')
  assert.equal((await service.versions()).length, 1)
  await service.saveDraft('# New draft\n')
  await service.restore((await service.versions())[0].id)
  assert.equal((await service.getSlides()).markdown, '# Draft\n')
  await service.saveAsset('test.svg', Buffer.from('<svg/>'))
  assert.equal((await service.listAssets()).length, 1)
  await assert.rejects(() => service.saveAsset('../../server.mjs', Buffer.from('x')), /仅支持/)
  const goodTheme = new AdmZip(); goodTheme.addFile('my-theme/theme.css', Buffer.from('.reveal{color:red}'))
  const uploaded = await service.uploadTheme('competition.zip', goodTheme.toBuffer())
  assert.equal(uploaded.id, 'competition')
  await service.selectDraftTheme(uploaded.id)
  assert.equal((await service.status()).dirty, true)
  const css = await service.getDraftThemeCss(); await service.saveDraftThemeCss(css.css + '\n/* edited */')
  assert.match((await service.getDraftThemeCss()).css, /edited/)
  const exportedTheme = await service.exportTheme('draft'); const exportedZip = new AdmZip(exportedTheme.data)
  assert.ok(exportedZip.getEntry('theme.css'))
  assert.ok(exportedZip.getEntry('theme-manifest.json'))
  assert.ok(exportedZip.getEntry('AI-修改说明.md'))
  const lcdSaved = await service.saveLcdTheme('large-text', { background:'#223344', taskFontSize:72, maxTaskLines:2 })
  assert.equal(lcdSaved.config.taskFontSize, 72)
  await service.selectDraftLcdTheme('large-text')
  assert.equal((await service.status()).draftLcdTheme, 'large-text')
  const lcdZip = new AdmZip(); lcdZip.addFile('lcd-theme.json', Buffer.from(JSON.stringify({taskFontSize:66})))
  assert.equal((await service.uploadLcdTheme('lcd-upload.zip', lcdZip.toBuffer())).config.taskFontSize, 66)
  const badTheme = new AdmZip(); badTheme.addFile('xx/theme.css', Buffer.from('bad'))
  const badBuffer = badTheme.toBuffer(); const from = Buffer.from('xx/theme.css'), to = Buffer.from('../theme.css')
  for (let offset = badBuffer.indexOf(from); offset >= 0; offset = badBuffer.indexOf(from, offset + to.length)) to.copy(badBuffer, offset)
  await assert.rejects(() => service.uploadTheme('bad.zip', badBuffer), /路径穿越/)
  console.log('Studio service: 22 assertions passed')
}
finally {
  await fsp.rm(root, { recursive: true, force: true })
}
