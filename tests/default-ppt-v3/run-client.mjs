/* eslint-env node */
/* eslint-disable no-console */
/**
 * 主屏 v3 上传 · 客户端逻辑全链路测试（真实模块 + 真实服务器 + 真实 500MB PPTX）：
 *   node tests/default-ppt-v3/run-client.mjs "D:/智证修改版.pptx"
 *
 * 在 Node 中以浏览器等价环境运行真实前端模块：
 * - pptxtojson 以 imageMode:'blob' 解析真实 PPTX（URL.createObjectURL 以 Blob 表模拟浏览器）
 * - bridgePptxBlobImages 桥接（与 useImport 共用同一实现）
 * - uploadMainDeckV3 完整走会话/资产/raw/bundle/commit（fetch 直连真实服务器）
 * - 校验：解析页数、图片引用全部 blob 化、上传后 bundle 中全部为资产 URL、
 *   页数一致、资产可访问、blob: 已替换且 revoke
 */
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PPTX = path.resolve(process.argv[2] || 'D:/智证修改版.pptx')
const EXTERNAL_BASE = process.env.PPTIST_V3_TEST_EXTERNAL_BASE || ''
const PORT = 18973
const BASE = EXTERNAL_BASE || `http://127.0.0.1:${PORT}`

const outfile = path.join(here, '.bundled-client-test.mjs')
await build({
  entryPoints: [path.join(here, 'client.test.mts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  alias: { '@': path.resolve(here, '../../src') },
  external: ['pptxtojson/dist/index.js'],
  logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"test"' },
})

const dataDir = mkdtempSync(path.join(tmpdir(), 'pptist-v3-client-'))
let child = null
if (!EXTERNAL_BASE) {
  child = spawn(process.execPath, [path.resolve('server/pptist-server.mjs')], {
    env: { ...process.env, PPTIST_PORT: String(PORT), PPTIST_REMOTE_API: '', PPTIST_DATA_DIR: path.join(dataDir, 'default-ppt'), PPTIST_SECONDARY_DATA_DIR: path.join(dataDir, 'secondary-ppt'), PPTIST_DIST_DIR: path.join(dataDir, 'dist'), PPTIST_MAX_UPLOAD_MB: '2048' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', b => process.stderr.write(b))
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/default-ppt-api/config`)).ok) break } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
}

const result = await import(`file://${outfile}?t=${Date.now()}`)
const failures = await result.run({ pptxPath: PPTX, base: BASE })

await new Promise(r => setTimeout(r, 300))
if (child) { child.kill(); await new Promise(r => child.once('exit', r)) }
await fsp.rm(outfile, { force: true })
if (!EXTERNAL_BASE) rmSync(dataDir, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
