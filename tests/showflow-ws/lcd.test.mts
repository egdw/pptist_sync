import assert from 'node:assert/strict'
import { parsePptLcdRemark } from '../../src/show-flow/lcd/ppt-note-parser.ts'
import { parseMarkdownManifest } from '../../src/show-flow/manifest.ts'

const expectedRoles = {
  manager: { task: '确认联调' }, platform: { task: '核对数据' },
  twin: { task: '准备仿真' }, hardware: { task: '执行操作' },
}
const ppt = parsePptLcdRemark('<p>普通备注</p><p>[LCD]<br>stage=车端联调<br>lead=hardware<br>active=manager,platform,hardware<br>manager=确认联调<br>platform=核对数据<br>twin=准备仿真<br>hardware=执行操作<br>[/LCD]</p>', 'b5')
assert.equal(ppt?.stage, '车端联调')
assert.equal(ppt?.lead, 'hardware')
assert.deepEqual(ppt?.active, ['manager', 'platform', 'hardware'])
assert.deepEqual(ppt?.roles, expectedRoles)
assert.equal(parsePptLcdRemark('只有普通备注', 'b6'), null)

const md = `# 车端联调
<!-- .slide:
 data-page-id="b5"
 data-stage="车端联调"
 data-lead="hardware"
 data-active="manager,platform,hardware"
 data-collab="manager=确认联调;platform=核对数据;twin=准备仿真;hardware=执行操作"
-->`
const lcd = parseMarkdownManifest(md)[0].lcd
assert.equal(lcd?.source.type, 'reveal-md')
assert.equal(lcd?.stage, ppt?.stage)
assert.deepEqual(lcd?.active, ppt?.active)
assert.deepEqual(lcd?.roles, expectedRoles)
console.log('✓ PPT remark 与 Markdown 产生统一 LcdSceneState；无 [LCD] 保持 null')
