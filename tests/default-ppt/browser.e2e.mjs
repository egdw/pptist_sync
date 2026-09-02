/**
 * 浏览器端到端验证（puppeteer 无头 Chrome，真实渲染 + 真实解析）
 *   前置：npm run build-only 后再运行；需要 npm install --no-save puppeteer ws
 *   运行：node tests/default-ppt/browser.e2e.mjs
 *
 * 覆盖验收项：
 * 1. A 打开播放页，B（独立浏览器上下文，模拟另一台电脑）上传后 A 自动显示新 PPT
 * 2. 播放页打开时无默认 PPT → 等待页，首次上传后自动放映
 * 3. 播放页刷新后仍自动播放最新默认 PPT
 * 10. 热替换只产生 ended + started（通过四字段协议在本地 WS 服务端实测捕获）
 * 12. 未进入原生全屏也能直接放映
 */
/* eslint-env node */
/* eslint-disable no-console */
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = 8688
const BASE = `http://127.0.0.1:${PORT}`
const WS_PORT = 8689
const DATA_DIR = path.join(ROOT, 'data/.e2e-temp')

const results = []
const ok = name => results.push(`  ✓ ${name}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// —— 本地 WS 服务端：捕获播放页通过四字段协议发出的放映事件 ——
const receivedEvents = []
let wsServer
async function startWsCapture() {
  const { WebSocketServer } = await import('ws')
  wsServer = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
  wsServer.on('connection', socket => {
    socket.on('message', data => {
      try {
        receivedEvents.push(JSON.parse(data.toString()))
      }
      catch { /* 忽略非 JSON */ }
    })
  })
  await new Promise(resolve => wsServer.on('listening', resolve))
}

// —— PPTist 服务端 ——
let server
let browser = null
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/pptist-server.mjs')], {
    env: {
      ...process.env,
      PPTIST_PORT: String(PORT),
      PPTIST_DATA_DIR: DATA_DIR,
      PPTIST_DIST_DIR: path.join(ROOT, 'dist'),
      PPTIST_REMOTE_API: '',
    },
  })
  await new Promise(resolve => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${BASE}/default-ppt-api/config`)
        if (res.ok) {
          clearInterval(timer)
          resolve()
        }
      }
      catch { /* 等待启动 */ }
    }, 200)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 15000)
  })
}
function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve()
    server.on('exit', resolve)
    server.kill()
    server = null
  })
}

try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  await startWsCapture()
  await startServer()

  // 整体看门狗：任何挂起（导航/对话框/端口占用等）都会在 150s 后强制退出
  setTimeout(() => {
    console.error('E2E 整体超时（150s），强制退出')
    process.exit(1)
  }, 150000)

  console.log('[e2e] launching browser'); const puppeteer = (await import('puppeteer')).default
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }); console.log('[e2e] browser launched')

  // 预置「放映联动」配置：WebSocket 通道指向本地捕获服务端（使用与正式功能相同的 localStorage 键）
  const seedLinkConfig = async page => {
    await page.evaluateOnNewDocument(config => {
      localStorage.setItem('PPTIST_PRESENTATION_LINK', JSON.stringify(config))
    }, {
      mqtt: { enabled: false, url: 'ws://', username: '', password: '', clientId: '', topic: 'presentation/events', qos: 1, retain: false },
      ws: { enabled: true, url: `ws://127.0.0.1:${WS_PORT}`, token: '' },
      rememberCredentials: false,
    })
  }

  // A 电脑：打开播放页（此时无默认 PPT）
  const pageA = await browser.newPage()
  // 生产构建带 onbeforeunload 拦截（上游行为），刷新时自动接受确认对话框
  pageA.on('dialog', dialog => dialog.accept().catch(() => {}))
  await seedLinkConfig(pageA)
  console.log('[e2e] opening play page'); await pageA.goto(`${BASE}/play`, { waitUntil: 'domcontentloaded' }); console.log('[e2e] play page loaded')
  await pageA.waitForSelector('.placeholder-title', { timeout: 20000 })
  const emptyTitle = await pageA.$eval('.placeholder-title', el => el.textContent.trim())
  assert.equal(emptyTitle, '暂无默认 PPT')
  ok('播放页打开（无默认 PPT）：显示「暂无默认 PPT」等待页，未显示编辑器或示例 PPT')

  // 等待 WS 通道连接：连接后无放映事件，不发送虚构 started
  await sleep(1500)
  assert.equal(receivedEvents.filter(e => e.event === 'presentation.started').length, 0)
  ok('无放映状态时不发送任何四字段事件（无虚构 started）')

  // B 电脑（独立浏览器上下文）：打开上传页，走真实解析 + 上传流程
  const contextB = await browser.createBrowserContext()
  const pageB = await contextB.newPage()
  pageB.on('dialog', dialog => dialog.accept().catch(() => {}))
  await pageB.goto(`${BASE}/upload`, { waitUntil: 'domcontentloaded' })
  await pageB.waitForSelector('.drop-area', { timeout: 20000 })
  const fileInput = await pageB.$('input[type=file]')
  assert.ok(fileInput, '上传页存在文件选择控件')
  await fileInput.uploadFile(path.join(ROOT, 'tests/default-ppt/sample-v1.pptx'))
  await pageB.waitForFunction(() => (document.querySelector('.step-status')?.textContent || '').includes('解析成功'), { timeout: 30000 })
  ok('上传页（B 电脑）：真实解析 sample-v1.pptx 成功（复用编辑器导入管线）')

  await pageB.click('.primary-btn')
  await pageB.waitForFunction(() => (document.querySelector('.success-text')?.textContent || '').includes('已设为默认 PPT'), { timeout: 30000 })
  ok('点击「上传并设为默认」：出现成功提示')

  // A 播放页自动进入放映
  await pageA.waitForFunction(() => !document.querySelector('.placeholder-title'), { timeout: 20000 })
  await sleep(1200)
  const slideText = await pageA.evaluate(() => document.body.innerText)
  assert.match(slideText, /季度经营汇报/)
  ok('A 播放页：首次上传成功后自动进入放映并显示新 PPT 内容（无需任何操作）')

  // 四字段事件：started 恰好一次（page=1，多行中文备注）
  const startedEvents = receivedEvents.filter(e => e.event === 'presentation.started')
  assert.equal(startedEvents.length, 1)
  assert.equal(startedEvents[0].page, 1)
  assert.match(startedEvents[0].notes, /第一页的演讲者备注/)
  assert.match(startedEvents[0].notes, /\n/)
  assert.deepEqual(Object.keys(startedEvents[0]).sort(), ['event', 'id', 'notes', 'page'])
  ok('四字段协议：started 一次（page=1，多行中文备注，恰好四个字段）')

  // B 再上传 v2（不同标题）：A 热替换
  const eventsBefore = receivedEvents.length
  const fileInput2 = await pageB.$('input[type=file]')
  await fileInput2.uploadFile(path.join(ROOT, 'tests/default-ppt/sample-v2.pptx'))
  await pageB.waitForFunction(() => (document.querySelector('.step-status')?.textContent || '').includes('解析成功'), { timeout: 30000 })
  await pageB.click('.primary-btn')
  await pageB.waitForFunction(() => (document.querySelector('.success-text')?.textContent || '').includes('已设为默认 PPT'), { timeout: 30000 })

  await pageA.waitForFunction(() => document.body.innerText.includes('第二版-热替换成功-NEW'), { timeout: 20000 })
  ok('热替换：A 播放页未刷新自动切换到 v2 内容')

  // 四字段事件：ended（旧稿）+ started（新稿第一页）
  const swapEvents = receivedEvents.slice(eventsBefore).filter(e => e.event !== 'slide.changed')
  assert.equal(swapEvents.length, 2, `热替换应恰好产生 ended+started：${JSON.stringify(receivedEvents.slice(eventsBefore))}`)
  assert.equal(swapEvents[0].event, 'presentation.ended')
  assert.equal(swapEvents[0].page, 1)
  assert.match(swapEvents[0].notes, /第一页的演讲者备注/)
  assert.equal(swapEvents[1].event, 'presentation.started')
  assert.equal(swapEvents[1].page, 1)
  assert.notEqual(swapEvents[0].id, swapEvents[1].id)
  const changedDuringSwap = receivedEvents.slice(eventsBefore).filter(e => e.event === 'slide.changed')
  assert.equal(changedDuringSwap.length, 0)
  ok('热替换四字段事件：ended（旧稿）→ started（新稿第 1 页），无多余 slide.changed，id 不同')

  // 刷新 A：仍自动播放最新默认 PPT（v2），浏览器允许时恢复原生全屏
  await pageA.reload({ waitUntil: 'domcontentloaded' })
  await pageA.waitForFunction(() => document.body.innerText.includes('第二版-热替换成功-NEW'), { timeout: 20000 })
  const fullscreenAfterReload = await pageA.evaluate(() => !!document.fullscreenElement)
  ok(fullscreenAfterReload
    ? '刷新播放页：自动放映最新默认 PPT（v2），并恢复原生全屏'
    : '刷新播放页：自动放映最新默认 PPT（v2），页面铺满可视区正常放映')

  // 原生全屏时右上角入口整排隐藏；未全屏时显示（全屏 / 放映联动 / 上传）
  if (fullscreenAfterReload) {
    const entryHidden = await pageA.evaluate(() => !document.querySelector('.upload-entry'))
    assert.equal(entryHidden, true)
    ok('原生全屏时右上角「放映联动 / 上传 / 全屏」入口整排隐藏，画面无遮挡')
    await pageA.evaluate(() => document.exitFullscreen())
    await sleep(500)
  }
  else ok('未进入原生全屏：页面铺满可视区正常放映，右上角入口可见')

  // 退出全屏后右上角入口恢复显示（全屏 / 放映联动 / 上传）
  const uploadEntryVisible = await pageA.$eval('.upload-entry-btn', el => {
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null
  })
  assert.equal(uploadEntryVisible, true)
  const entryCount = await pageA.$$eval('.upload-entry .upload-entry-btn', els => els.length)
  assert.equal(entryCount, 3)

  // 通过按钮文本精确定位（避免受全屏按钮显隐影响）
  const clickEntry = label => pageA.evaluate(text => {
    const btn = [...document.querySelectorAll('.upload-entry-btn')].find(b => b.textContent.includes(text))
    if (!btn) return false
    btn.click()
    return true
  }, label)

  await clickEntry('上传 / 更换 PPT')
  await sleep(300)
  const guideUrl2 = await pageA.evaluate(() => {
    const el = document.querySelectorAll('.guide-panel .address')[0]
    return el ? el.textContent.trim() : ''
  })
  assert.equal(guideUrl2, `${BASE}/upload`)
  ok('播放页右上角上传/放映联动/全屏入口默认可见，指引显示完整上传地址')

  // 关闭指引浮层，再打开放映联动设置面板（MQTT/WebSocket 配置不依赖编辑器）
  await pageA.evaluate(() => {
    const btn = [...document.querySelectorAll('.guide-panel .mini-btn')].find(b => b.textContent.includes('关闭'))
    btn?.click()
  })
  await sleep(200)
  const linkPanelOpened = await pageA.evaluate(() => {
    const btn = [...document.querySelectorAll('.upload-entry-btn')].find(b => b.textContent.includes('放映联动'))
    if (!btn) return false
    btn.click()
    return new Promise(resolve => setTimeout(() => resolve(!!document.querySelector('.presentation-link-panel')), 300))
  })
  assert.equal(linkPanelOpened, true)
  ok('播放页可打开放映联动设置面板（MQTT/WebSocket 配置）')

  // 编辑器路径保留原有能力，且与大屏播放页对齐（打开的是同一份默认文稿）
  await pageB.goto(`${BASE}/editor`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const editorLoaded = await pageB.evaluate(() => !!document.querySelector('.pptist-editor'))
  assert.equal(editorLoaded, true)
  const editorHasDefault = await pageB.evaluate(() => document.body.innerText.includes('第二版-热替换成功-NEW'))
  assert.equal(editorHasDefault, true)
  ok('/editor 保留原有编辑器，且加载与大屏播放页相同的默认文稿')

  // / 恢复为原有编辑器入口（同样对齐默认文稿）
  const pageC = await browser.newPage()
  pageC.on('dialog', dialog => dialog.accept().catch(() => {}))
  await pageC.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  const rootIsEditor = await pageC.evaluate(() => !!document.querySelector('.pptist-editor'))
  assert.equal(rootIsEditor, true)
  const rootHasDefault = await pageC.evaluate(() => document.body.innerText.includes('第二版-热替换成功-NEW'))
  assert.equal(rootHasDefault, true)
  ok('/ 恢复为原有编辑器界面（打开同一份默认 PPT，原使用习惯不受影响）')

  // —— PDF 支持与点击翻页 ——
  // B 上传 PDF（真实 pdf.js 解析，每页渲染为图片页，文字提取为备注）
  const eventsBeforePdf = receivedEvents.length
  await pageB.goto(`${BASE}/upload`, { waitUntil: 'domcontentloaded' })
  await sleep(800)
  const pdfInput = await pageB.$('input[type=file]')
  assert.ok(pdfInput, '上传页存在文件选择控件')
  await pdfInput.uploadFile(path.join(ROOT, 'tests/default-ppt/sample-v1.pdf'))
  await pageB.waitForFunction(() => (document.querySelector('.step-status')?.textContent || '').includes('解析成功'), { timeout: 60000 })
  await pageB.click('.primary-btn')
  await pageB.waitForFunction(() => (document.querySelector('.success-text')?.textContent || '').includes('已设为默认 PPT'), { timeout: 30000 })
  ok('上传 PDF：pdf.js 真实解析 2 页并设为默认')

  // A 自动切换到 PDF 文稿（2 页），页码指示显示 1 / 2
  await pageA.waitForFunction(() => (document.querySelector('.page-number')?.textContent || '').replace(/\s/g, '').includes('1/2'), { timeout: 20000 })
  ok('PDF 热替换：播放页自动切换到 PDF 文稿（从第 1 页开始）')

  // 点击画面翻页 → 第 2 页
  await pageA.evaluate(() => {
    document.querySelector('.screen-slide-list').parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(600)
  const pageNoAfterClick = await pageA.evaluate(() => (document.querySelector('.page-number')?.textContent || '').replace(/\s/g, ''))
  assert.equal(pageNoAfterClick, '幻灯片2/2')
  ok('播放页点击画面翻页：点击后进入第 2 页')

  // 四字段事件：ended（v2 第 1 页）+ started（PDF 第 1 页，备注为 PDF 提取文字）
  const pdfSwap = receivedEvents.slice(eventsBeforePdf).filter(e => e.event !== 'slide.changed')
  assert.equal(pdfSwap.length, 2, `PDF 热替换应恰好产生 ended+started：${JSON.stringify(receivedEvents.slice(eventsBeforePdf))}`)
  assert.equal(pdfSwap[0].event, 'presentation.ended')
  assert.equal(pdfSwap[1].event, 'presentation.started')
  assert.match(pdfSwap[1].notes, /PDF Slide One/)
  assert.equal(pdfSwap[1].page, 1)
  ok('PDF 热替换四字段事件：ended + started，started 备注为 PDF 提取的文字')

  // 右上角「全屏」按钮：点击进入原生全屏（带真实用户激活），不影响放映；已全屏时按钮隐藏
  await pageA.bringToFront()
  const fullscreenNowBefore = await pageA.evaluate(() => !!document.fullscreenElement)
  if (!fullscreenNowBefore) {
    const clicked = await pageA.evaluate(() => {
      const btn = [...document.querySelectorAll('.upload-entry-btn')].find(b => b.textContent.replace(/\s/g, '') === '全屏')
      if (!btn) return false
      btn.click()
      return true
    })
    assert.equal(clicked, true, '未全屏时右上角存在「全屏」按钮')
    await sleep(800)
  }
  const fullscreenNow = await pageA.evaluate(() => !!document.fullscreenElement)
  const stillOnPdf = await pageA.evaluate(() => (document.querySelector('.page-number')?.textContent || '').replace(/\s/g, ''))
  assert.equal(stillOnPdf, '幻灯片2/2')
  if (fullscreenNow) ok('播放页处于原生全屏，放映继续（点击全屏按钮或刷新后自动恢复）')
  else console.log('  · （无头环境未进入原生全屏，真实浏览器中通过全屏按钮/首次翻页进入；放映不受影响）')

  await browser.close()

  console.log('浏览器端到端验证（puppeteer 无头 Chrome，真实渲染与真实解析）：')
  results.forEach(line => console.log(line))
  console.log('\n全部通过 ✔')
  process.exit(0)
}
catch (error) {
  console.error('E2E 失败：', error)
  process.exitCode = 1
}
finally {
  // 无论成功失败都关闭浏览器，否则残留的 Chrome 子进程会让本进程无法退出
  try {
    if (browser) await browser.close()
  }
  catch { /* 忽略 */ }
  await stopServer()
  if (wsServer) await new Promise(resolve => wsServer.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(process.exitCode || 0)
}
