/* eslint-disable no-console */
/**
 * 无头 Chrome（原生 CDP）复现 /upload 主屏上传 D:\智证修改版.pptx 全流程。
 * 输出：console 错误、网络失败、解析/上传各阶段状态与最终结果。
 * 用法：node tests/default-ppt-v3/browser-upload.cdp.mjs [端口]
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

const PORT = Number(process.argv[2] || 8686)
const CDP_PORT = 19222
const FILE = 'D:/智证修改版.pptx'

if (!fs.existsSync(FILE)) { console.error('测试文件不存在:', FILE); process.exit(1) }

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-upload-'))
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900',
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

const wsUrl = await waitWs()
const ws = new WebSocket(wsUrl, { maxPayload: 512 * 1024 * 1024 })
await new Promise(r => ws.once('open', r))

let seq = 0
const pending = new Map()
const consoleLogs = []
const failedRequests = []
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString())
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ')
    consoleLogs.push(`[${msg.params.type}] ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleLogs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text))
  }
  if (msg.method === 'Network.loadingFailed') {
    failedRequests.push(`${msg.params.errorText} ${msg.params.blockedReason || ''}`)
  }
})
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/upload` })
await sleep(4000)

// 文件选择（输入框渲染时机不定，重试查找）
let rootId = 0
let inputNodeId = 0
for (let i = 0; i < 15 && !inputNodeId; i++) {
  const node = await send('DOM.getDocument', {})
  rootId = node?.result?.root?.nodeId || 0
  if (rootId) {
    const inputNode = await send('DOM.querySelector', { nodeId: rootId, selector: 'input[type="file"]' })
    inputNodeId = inputNode?.result?.nodeId || 0
  }
  if (!inputNodeId) await sleep(1000)
}
if (!inputNodeId) { console.error('未找到文件输入框'); consoleLogs.slice(-10).forEach(l => console.log(l)); chrome.kill(); process.exit(1) }
await send('DOM.setFileInputFiles', { files: [FILE], nodeId: inputNodeId })
console.log('已选择文件，等待解析...')

// 等解析完成（按钮可用）
let parsed = false
for (let i = 0; i < 120; i++) {
  await sleep(2000)
  const st = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /上传并设为默认/.test(b.textContent))
    return { disabled: btn?.disabled, status: document.querySelector('.step-status')?.textContent || '', error: document.querySelector('.error-text')?.textContent || '' }
  })()`)
  if (st.error) { console.log('解析错误:', st.error); break }
  if (st.status.includes('解析成功')) { parsed = true; console.log('解析完成:', st.status); break }
  if (i % 5 === 4) console.log(`[${(i + 1) * 2}s]`, st.status || '(等待中)')
}
if (!parsed) {
  console.log('\n=== Console 日志(最后20条) ==='); consoleLogs.slice(-20).forEach(l => console.log(l))
  console.log('=== 失败请求 ==='); failedRequests.forEach(f => console.log(f))
  chrome.kill(); fs.rmSync(userData, { recursive: true, force: true }); process.exit(1)
}

// 点击上传（先注入 fetch 记录器 + 全局错误捕获）
await evaluate(`(() => {
  window.__fetchLog = []
  window.__rej = null; window.__err = null
  window.addEventListener('unhandledrejection', e => { window.__rej = (e.reason && (e.reason.stack || e.reason.message || String(e.reason))) || String(e) })
  window.addEventListener('error', e => { window.__err = (e.error && (e.error.stack || e.error.message)) || e.message })
  const orig = window.fetch
  window.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
    try {
      const res = await orig(...args)
      window.__fetchLog.push(url + ' -> ' + res.status + ' @ ' + (new Error().stack.split(String.fromCharCode(10)).slice(2,4).join(' | ')))
      return res
    }
    catch (e) {
      window.__fetchLog.push(url + ' -> THROW ' + (e && e.message) + ' @ ' + (new Error().stack.split(String.fromCharCode(10)).slice(2,4).join(' | ')))
      throw e
    }
  }
})()`)
await evaluate(`[...document.querySelectorAll('button')].find(b => /上传并设为默认/.test(b.textContent))?.click()`)
console.log('已点击上传，等待上传完成...')

let done = false
for (let i = 0; i < 150; i++) {
  await sleep(2000)
  const st = await evaluate(`(() => ({
    status: document.querySelector('.step-status')?.textContent || '',
    success: document.querySelector('.success-text')?.textContent || '',
    error: document.querySelector('.error-text')?.textContent || '',
    progress: document.querySelector('.progress-inner')?.style?.width || document.querySelector('.progress')?.textContent?.trim() || ''
  }))()`)
  if (st.success || st.error) {
    console.log('\n结果:', st.success || st.error)
    done = !!st.success
    break
  }
  if (i % 5 === 4) console.log(`[${(i + 1) * 2}s]`, st.status, st.progress)
}

console.log('\n=== Console 错误/异常 ===')
consoleLogs.filter(l => /\[error\]|\[warning\]|exception|Error/i.test(l)).slice(-15).forEach(l => console.log(l))
console.log('=== 失败请求(最后10) ===')
failedRequests.slice(-10).forEach(f => console.log(f))
console.log('=== 页面 fetch 日志(全量) ===')
const fetchLog = await evaluate('JSON.stringify(window.__fetchLog || [])')
try { JSON.parse(fetchLog).forEach(l => console.log(l)) } catch { console.log(fetchLog) }
console.log('=== unhandledrejection ===', await evaluate('window.__rej || "(无)"'))
console.log('=== window error ===', await evaluate('window.__err || "(无)"'))
const finalStatus = await evaluate(`JSON.stringify({status: document.querySelector('.step-status')?.textContent, error: document.querySelector('.error-text')?.textContent})`)
console.log('=== 最终状态 ===', finalStatus)

chrome.kill()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* Windows 句柄延迟，忽略 */ }
process.exit(done ? 0 : 1)
