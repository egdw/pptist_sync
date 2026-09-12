/* eslint-env node */
/* eslint-disable no-console */
/**
 * GIF→视频转码器测试：真实大 GIF 转码 + bundle 覆盖层改写。
 * 需要 ffmpeg（开发机 .devtools 或 PATH）；无 ffmpeg 时跳过并提示。
 * 用法：node tests/default-ppt-v3/gif-transcode.test.mjs [大GIF路径]
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createGifTranscoder } from '../../server/gif-transcode.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const bigGif = process.argv[2]
  || fs.readdirSync(path.join(root, 'data/default-ppt/assets'))
    .map(f => ({ f, s: fs.statSync(path.join(root, 'data/default-ppt/assets', f)).size }))
    .filter(x => x.f.endsWith('.gif') && x.s > 5_000_000)
    .sort((a, b) => b.s - a.s)[0]?.f

const work = await fsp.mkdtemp(path.join(path.resolve(root), 'data/tmp', 'gif-transcode-test-'))
const assetsDir = path.join(work, 'assets')
await fsp.mkdir(assetsDir, { recursive: true })

const logs = []
const log = (...a) => { logs.push(a.join(' ')); console.log(...a) }

const transcoder = createGifTranscoder({ assetsDir, thresholdMB: 1, log })
if (!(await transcoder.ensureFfmpeg())) {
  console.log('SKIP: 无 ffmpeg，转码功能不可用（生产环境 apt install ffmpeg）')
  await fsp.rm(work, { recursive: true, force: true })
  process.exit(0)
}
if (!bigGif) {
  console.log('SKIP: 无 >5MB 测试 GIF')
  await fsp.rm(work, { recursive: true, force: true })
  process.exit(0)
}

// 把真实 GIF 按资产命名规则放入池
const bytes = await fsp.readFile(bigGigSafe())
function bigGigSafe() { return bigGif.includes('/') || bigGigIncludes() ? bigGif : path.join(root, 'data/default-ppt/assets', bigGif) }
function bigGigIncludes() { return false }
const assetName = `${crypto.createHash('sha256').update(bytes).digest('hex')}.gif`
await fsp.writeFile(path.join(assetsDir, assetName), bytes)
const sizeMB = (bytes.length / 1e6).toFixed(1)
console.log(`样本: ${path.basename(bigGif)} ${sizeMB}MB → 资产 ${assetName.slice(0, 16)}…`)

// 1. bundle 覆盖层升级
const bundle = {
  slides: [
    { background: { type: 'image', image: { src: '/default-ppt-api/assets/eee.png' } },
      elements: [
        { type: 'image', id: 'a', src: `/default-ppt-api/assets/${assetName}`, left: 1, top: 2, width: 3, height: 4 },
        { type: 'image', id: 'b', src: '/default-ppt-api/assets/small.gif' },
      ] },
  ],
}
await fsp.writeFile(path.join(assetsDir, 'small.gif'), Buffer.alloc(1024)) // 阈值下：不动
await fsp.writeFile(path.join(assetsDir, 'eee.png'), Buffer.alloc(1024))

const changed = await transcoder.upgradeBundleOverlays(bundle)
assert.equal(changed, true, '应发生改写')
const el = bundle.slides[0].elements[0]
assert.equal(el.type, 'video', '元素应变视频')
assert.match(el.src, /^\/default-ppt-api\/assets\/[a-f0-9]{64}\.(mp4|webm)$/, 'src 应为视频资产 URL')
assert.equal(el.autoplay, true)
assert.ok(el.poster, '应有 poster')
assert.equal(el.id, 'a', '保留元素 id/几何')
assert.equal(bundle.slides[0].elements[1].type, 'image', '阈值以下的 GIF 不动')
console.log(`✓ 覆盖层改写: → ${el.src.split('/').pop()}（${el.poster ? '含 poster' : '无 poster'}）`)

// 2. 视频资产真实存在且显著变小
const videoName = el.src.split('/').pop()
const videoStat = await fsp.stat(path.join(assetsDir, videoName))
console.log(`✓ 视频资产: ${(videoStat.size / 1e6).toFixed(2)}MB（原 GIF ${sizeMB}MB，压缩比 ${(bytes.length / videoStat.size).toFixed(1)}x）`)
assert.ok(videoStat.size < bytes.length, '视频应小于原 GIF')
if (videoName.endsWith('.webm')) console.log('  （检测到透明通道 → VP9 WebM）')

// 3. 幂等：再次升级不再变化
const changed2 = await transcoder.upgradeBundleOverlays(bundle)
assert.equal(changed2, false, '二次升级应为幂等')
console.log('✓ 幂等：二次升级无变化')

await fsp.rm(work, { recursive: true, force: true })
console.log('\ngif-transcode: 全部断言通过')
