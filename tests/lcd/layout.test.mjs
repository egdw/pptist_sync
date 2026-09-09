import assert from 'node:assert/strict'
import { createCanvas } from '@napi-rs/canvas'
import { drawDefaultTemplate } from '../../server/led/templates/default.mjs'

const canvas = createCanvas(1280, 800)
const ctx = canvas.getContext('2d')
const calls = []
const fillText = ctx.fillText.bind(ctx)
ctx.fillText = (text, x, y, maxWidth) => {
  calls.push({ text: String(text), x, y, font: ctx.font, baseline: ctx.textBaseline })
  return fillText(text, x, y, maxWidth)
}

drawDefaultTemplate(ctx, {
  stage: '车端联调',
  lead: 'platform',
  active: ['platform'],
  roles: { platform: { task: '平台接收车辆数据并完成完整性校验、可信存证与异常结果复核确认' } },
}, 'platform', null, {
  stageFontSize: 82,
  roleFontSize: 82,
  taskFontSize: 86,
  maxTaskLines: 4,
  customCss: `:root {
    --lcd-stage-label-font-size: 999px;
    --lcd-role-index-font-size: 999px;
    --lcd-task-label-font-size: 999px;
    --lcd-badge-font-size: 999px;
    --lcd-footer-font-size: 999px;
  }`,
})

const call = text => calls.find(item => item.text === text)
assert.match(call('当前环节').font, /^40px /, 'CSS 字号必须限制在安全范围')
assert.match(call('02').font, /^bold 48px /)
assert.match(call('当前任务').font, /^40px /)
assert.match(call('当前任务主要负责人').font, /^bold 36px /)
assert.match(call('当前任务主要负责人 · 工作进行中').font, /^34px /)
assert.equal(call('车端联调').baseline, 'top', '阶段标题应从安全区域顶部向下排版')
assert.equal(call('车端联调').y, 84)
assert.ok(calls.some(item => item.text.includes('平台系统开发工程')), '岗位标题应正常绘制')
assert.ok(calls.filter(item => item.baseline === 'top').every(item => item.y <= 696), '正文不得侵入底部状态条')

console.log('LCD layout: safe large-font regions and labels passed')
