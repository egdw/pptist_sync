import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createCanvas } from '@napi-rs/canvas'
import { createMonitorService } from '../../server/monitor-service.mjs'

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptist-monitor-test-'))
try {
  const png = color => { const canvas = createCanvas(40, 30); const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 40, 30); return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}` }
  const service = createMonitorService({ cacheDir: dir })
  await service.init()
  const main = await service.applyHalf('main', { image: png('#ff0000'), page: 2, total: 8 })
  const secondary = await service.applyHalf('secondary', { image: png('#00ff00'), page: 3, total: 12 })
  assert.equal(main.revision, 1)
  assert.equal(secondary.revision, 2)
  assert.notEqual(main.sha256, secondary.sha256)
  assert.equal((await service.displayJpeg(1))?.length > 0, true)
  assert.equal((await service.displayJpeg(2))?.length > 0, true)
  assert.equal(service.status().url, '/monitor-api/display/2.jpg')
  console.log('Monitor service: immutable revision + SHA256 checks passed')
}
finally { await fsp.rm(dir, { recursive: true, force: true }) }
