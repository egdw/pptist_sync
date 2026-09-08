/* eslint-env node */
/* eslint-disable no-console */
/**
 * 双槽位文稿存储隔离自测（主屏 /default-ppt-api vs 副屏 /showflow-api/secondary-doc）：
 *   npm run test:showflow:secondary-doc
 *
 * 自建自停服务器（临时数据目录），验证：
 * - 副屏上传后主屏 current/slides 完全不变
 * - 主屏上传后副屏完全不变
 * - 各槽位 seq 独立递增、slides 内容与上传一致
 * - 副屏空槽返回 404 / exists:false
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'

const PORT = 8798
const dataMain = mkdtempSync(path.join(tmpdir(), 'pptist-main-'))
const dataSecondary = mkdtempSync(path.join(tmpdir(), 'pptist-secondary-'))
const distTmp = mkdtempSync(path.join(tmpdir(), 'pptist-dist-'))

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('✓', name) } else { fail++; console.log('✗ FAIL:', name) } }
const wait = ms => new Promise(r => setTimeout(r, ms))

function buildEnvelope(filename, bundleObj, rawContent) {
  const headerBytes = Buffer.from(JSON.stringify({ filename, pageCount: bundleObj.slides.length }))
  const bundleBytes = Buffer.from(JSON.stringify(bundleObj))
  const raw = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(rawContent)])
  const head = Buffer.alloc(8)
  head.writeUInt32BE(headerBytes.length, 0)
  head.writeUInt32BE(bundleBytes.length, 4)
  return Buffer.concat([head, headerBytes, bundleBytes, raw])
}

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: apiPath, method, headers: body ? { 'Content-Type': 'application/octet-stream' } : {} }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const server = spawn(process.execPath, ['server/pptist-server.mjs'], {
  env: {
    ...process.env,
    PPTIST_PORT: String(PORT),
    PPTIST_REMOTE_API: '',
    PPTIST_DATA_DIR: dataMain,
    PPTIST_SECONDARY_DATA_DIR: dataSecondary,
    PPTIST_DIST_DIR: distTmp,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', c => process.stdout.write(`  ${c}`))
server.stderr.on('data', c => process.stdout.write(`  [err] ${c}`))

const main = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      await request('GET', '/default-ppt-api/config')
      break
    }
    catch { await wait(250) }
  }

  // —— 空槽位初始状态 ——
  const emptyMain = await request('GET', '/default-ppt-api/current')
  const emptySecondary = await request('GET', '/showflow-api/secondary-doc/current')
  const emptySecondarySlides = await request('GET', '/showflow-api/secondary-doc/current/slides')
  ok(emptyMain.json?.exists === false, '主屏槽初始为空')
  ok(emptySecondary.json?.exists === false, '副屏槽初始为空')
  ok(emptySecondarySlides.status === 404, '副屏空槽 slides 返回 404')

  // —— 主屏上传 deck A（10 页）——
  const deckA = { title: '主屏文稿A', slides: Array.from({ length: 10 }, (_, i) => ({ id: `a${i + 1}` })), theme: {} }
  const upMain = await request('POST', '/default-ppt-api/upload', buildEnvelope('deck-a.pptx', deckA, 'main-raw'))
  ok(upMain.json?.ok === true && upMain.json?.pageCount === 10, '主屏上传 deck A 成功（10 页）')

  // —— 副屏上传 deck B（17 页，不同内容）——
  const deckB = { title: '副屏文稿B', slides: Array.from({ length: 17 }, (_, i) => ({ id: `b${i + 1}` })), theme: {} }
  const upSecondary = await request('POST', '/showflow-api/secondary-doc/upload', buildEnvelope('deck-b.pptx', deckB, 'secondary-raw'))
  ok(upSecondary.json?.ok === true && upSecondary.json?.pageCount === 17, '副屏上传 deck B 成功（17 页）')

  // —— 隔离性：互相不影响 ——
  const mainMeta = await request('GET', '/default-ppt-api/current')
  const secondaryMeta = await request('GET', '/showflow-api/secondary-doc/current')
  ok(mainMeta.json?.filename === 'deck-a.pptx' && mainMeta.json?.pageCount === 10, '副屏上传后主屏 current 不变（deck A）')
  ok(secondaryMeta.json?.filename === 'deck-b.pptx' && secondaryMeta.json?.pageCount === 17, '主屏数据不影响副屏 current（deck B）')
  ok(mainMeta.json?.seq === 1 && secondaryMeta.json?.seq === 1, '两槽位 seq 各自独立从 1 递增')

  const mainSlides = await request('GET', '/default-ppt-api/current/slides')
  const secondarySlides = await request('GET', '/showflow-api/secondary-doc/current/slides')
  const parsedMain = JSON.parse(mainSlides.text)
  const parsedSecondary = JSON.parse(secondarySlides.text)
  ok(parsedMain.slides.length === 10 && parsedMain.slides[0].id === 'a1', '主屏 slides 内容正确（a1..a10）')
  ok(parsedSecondary.slides.length === 17 && parsedSecondary.slides[0].id === 'b1', '副屏 slides 内容正确（b1..b17）')
  ok(secondarySlides.headers['x-pptist-version'] === 'v1', '副屏响应带版本头')

  // —— 副屏版本更新（模拟换稿）：主屏继续不受影响 ——
  const deckB2 = { title: '副屏文稿B-v2', slides: Array.from({ length: 5 }, (_, i) => ({ id: `c${i + 1}` })), theme: {} }
  await request('POST', '/showflow-api/secondary-doc/upload', buildEnvelope('deck-b2.pptx', deckB2, 'secondary-raw-2'))
  const secondaryMeta2 = await request('GET', '/showflow-api/secondary-doc/current')
  const mainMeta2 = await request('GET', '/default-ppt-api/current')
  ok(secondaryMeta2.json?.seq === 2 && secondaryMeta2.json?.pageCount === 5, '副屏换稿 seq 递增（v2，5 页）')
  ok(mainMeta2.json?.seq === 1 && mainMeta2.json?.filename === 'deck-a.pptx', '副屏换稿后主屏仍为 deck A v1')

  // —— 主屏换稿：副屏不受影响 ——
  await request('POST', '/default-ppt-api/upload', buildEnvelope('deck-a2.pptx', { title: 'A2', slides: [{ id: 'x1' }], theme: {} }, 'main-raw-2'))
  const mainMeta3 = await request('GET', '/default-ppt-api/current')
  const secondaryMeta3 = await request('GET', '/showflow-api/secondary-doc/current')
  ok(mainMeta3.json?.seq === 2 && mainMeta3.json?.filename === 'deck-a2.pptx', '主屏换稿成功（v2）')
  ok(secondaryMeta3.json?.seq === 2 && secondaryMeta3.json?.filename === 'deck-b2.pptx', '主屏换稿后副屏仍为 deck B v2')

  // —— 原始文件下载隔离 ——
  const secondaryFile = await request('GET', '/showflow-api/secondary-doc/current/file')
  ok(secondaryFile.text.startsWith('PK\x03\x04') && secondaryFile.text.includes('secondary-raw-2'), '副屏原始文件下载正确')

  server.kill()
  await wait(200)
  rmSync(dataMain, { recursive: true, force: true })
  rmSync(dataSecondary, { recursive: true, force: true })
  rmSync(distTmp, { recursive: true, force: true })
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  server.kill()
  console.error(err)
  process.exit(1)
})
