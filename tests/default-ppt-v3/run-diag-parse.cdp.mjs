/* eslint-disable no-console */
// CDP 驱动：无头 Chrome 中用 pptxtojson 解析真实 PPTX，输出各页图片元素 src 状态
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import WebSocket from 'ws'

const CDP_PORT = 19233
const FILE = 'D:/智证修改版.pptx'

// 打包诊断脚本为 IIFE
const root = path.resolve(import.meta.dirname, '../..')
const bundle = execSync(
  `npx esbuild ${JSON.stringify(path.join(root, 'tests/default-ppt-v3/diag-parse-src.mjs'))} --bundle --format=iife --minify`,
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-diag-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--allow-file-access-from-files',
  'about:blank',
], { stdio: 'ignore' })

const waitWs = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = list.find(t => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    }
    catch {}
    await sleep(300)
  }
  throw new Error('CDP 未就绪')
}

const ws = new WebSocket(await waitWs(), { maxPayload: 512 * 1024 * 1024 })
await new Promise(r => ws.once('open', r))
let seq = 0
const pending = new Map()
const consoleLogs = []
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  if (msg.method === 'Runtime.consoleAPICalled') consoleLogs.push((msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' '))
  if (msg.method === 'Runtime.exceptionThrown') consoleLogs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text))
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 600000 })
  if (r.result?.exceptionDetails) console.log('EVAL 异常:', JSON.stringify(r.result.exceptionDetails).slice(0, 500))
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')

// 注入打包后的诊断脚本（IIFE 直接求值）
const r1 = await send('Runtime.evaluate', { expression: bundle, returnByValue: false })
if (r1.result?.exceptionDetails) { console.log('注入失败:', JSON.stringify(r1.result.exceptionDetails).slice(0, 400)); chrome.kill(); process.exit(1) }
if (!(await evaluate('typeof window.__diag'))) { console.log('注入后未找到 __diag'); chrome.kill(); process.exit(1) }

// 建文件输入并选择文件
await evaluate(`document.body.innerHTML = '<input type="file">'`)
const doc = await send('DOM.getDocument', {})
const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type="file"]' })
await send('DOM.setFileInputFiles', { files: [FILE], nodeId: input.result.nodeId })
console.log('文件已选择，开始解析（约 1-2 分钟）...')

const result = await evaluate('window.__diag(document.querySelector("input").files[0])')
if (!result) {
  console.log('无返回。Console:'); consoleLogs.slice(-10).forEach(l => console.log(l))
  chrome.kill(); process.exit(1)
}

console.log('总页数:', result.pageCount, '画布:', JSON.stringify(result.size))
console.log('\n=== 空 src 图片分布（仅列非零页） ===')
result.emptyPages.forEach(p => console.log(`第${p.page}页: ${p.deadImgs}/${p.total} 个图片提取失败`))
console.log('\n=== 第2页全部元素 ===')
for (const e of result.page2.elements) {
  console.log(`${e.type} | ${e.name} | pos(${e.x},${e.y}) ${e.w}x${e.h} | srcLen=${e.srcLen} blobLen=${e.blobLen} | ${e.srcHead}`)
}

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
process.exit(0)
